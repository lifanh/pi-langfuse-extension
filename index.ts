import { existsSync, unlinkSync } from "node:fs";

import type {
  AgentEndEvent,
  BeforeProviderRequestEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

/** Pi events missing from the public package exports are re-declared locally. */
interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

interface ProviderResponseEvent {
  type: "after_provider_response";
  status: number;
  headers: Record<string, string>;
}

interface AssistantMessageEndEvent {
  type: "message_end";
  message: {
    role?: string | undefined;
    content?: unknown;
    api?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
    responseModel?: string | undefined;
    responseId?: string | undefined;
    usage?: {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
      totalTokens?: number | undefined;
      cost?: {
        input?: number | undefined;
        output?: number | undefined;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
        total?: number | undefined;
      } | undefined;
    } | undefined;
    stopReason?: string | undefined;
    errorMessage?: string | undefined;
  };
}

import type { LangfuseAgent, LangfuseTool } from "@langfuse/tracing";

import {
  configPathForHome,
  DEFAULT_LANGFUSE_HOST,
  loadConfig,
  loadConfigFromEnv,
  loadConfigFromFile,
  sanitizeConfigForLog,
  saveConfig,
  type LangfuseConfig,
} from "./src/config.js";
import { redactValue } from "./src/redaction.js";
import {
  buildGenerationPayload,
  buildRunPayload,
  buildToolPayload,
  type RunContextLike,
  type RunPayload,
  type GenerationPayload,
} from "./src/telemetry.js";
import type { CapturedPayload } from "./src/capture-policy.js";
import {
  createAgentSpan,
  createGenerationSpan,
  createToolSpan,
  endAgentSpan,
  endGenerationSpan,
  endToolSpan,
  flush,
  getLastError,
  initTransport,
  isReady,
  setTraceAttributes,
  shutdown,
  type TraceAttributes,
} from "./src/transport.js";

interface ToolRun {
  startedAt: Date;
  endedAt?: Date;
  payload: CapturedPayload;
  toolSpan: LangfuseTool | null;
}

interface GenerationRun {
  turnIndex: number;
  request: BeforeProviderRequestEvent | undefined;
  response: ProviderResponseEvent | undefined;
  payload: GenerationPayload | undefined;
  generationSpan: import("@langfuse/tracing").LangfuseGeneration | null;
}

interface CurrentRun {
  startedAt: Date;
  endedAt?: Date;
  sessionId: string | undefined;
  payload: RunPayload;
  tools: Map<string, ToolRun>;
  generations: Map<number, GenerationRun>;
  activeTurnIndex: number;
  activeMessageEnd: AssistantMessageEndEvent | undefined;
  agentSpan: LangfuseAgent | null;
}

function notify(
  ctx: ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    console.log(message);
  }
}

function parseConfigureArgs(args: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of args.trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

const EXTENSION_NAME = "@lifanh/pi-langfuse-extension";
const STATUS_KEY = "langfuse";

type CaptureArgName =
  | "captureInputs"
  | "captureOutputs"
  | "captureToolIo"
  | "captureSystemPrompt"
  | "captureCwd"
  | "debug";

const CAPTURE_ARG_TO_ENV: Array<[CaptureArgName, string]> = [
  ["captureInputs", "LANGFUSE_CAPTURE_INPUTS"],
  ["captureOutputs", "LANGFUSE_CAPTURE_OUTPUTS"],
  ["captureToolIo", "LANGFUSE_CAPTURE_TOOL_IO"],
  ["captureSystemPrompt", "LANGFUSE_CAPTURE_SYSTEM_PROMPT"],
  ["captureCwd", "LANGFUSE_CAPTURE_CWD"],
  ["debug", "LANGFUSE_DEBUG"],
];

const MINIMAL_METADATA_CAPTURE: Record<string, string> = {
  LANGFUSE_CAPTURE_INPUTS: "false",
  LANGFUSE_CAPTURE_OUTPUTS: "false",
  LANGFUSE_CAPTURE_TOOL_IO: "false",
  LANGFUSE_CAPTURE_SYSTEM_PROMPT: "false",
  LANGFUSE_CAPTURE_CWD: "false",
};

const PRIVACY_PRESETS: Record<string, Record<string, string>> = {
  minimal: MINIMAL_METADATA_CAPTURE,
  strict: MINIMAL_METADATA_CAPTURE,
  "prompts-only": {
    LANGFUSE_CAPTURE_INPUTS: "true",
    LANGFUSE_CAPTURE_OUTPUTS: "false",
    LANGFUSE_CAPTURE_TOOL_IO: "false",
    LANGFUSE_CAPTURE_SYSTEM_PROMPT: "false",
    LANGFUSE_CAPTURE_CWD: "false",
  },
  conversations: {
    LANGFUSE_CAPTURE_INPUTS: "true",
    LANGFUSE_CAPTURE_OUTPUTS: "true",
    LANGFUSE_CAPTURE_TOOL_IO: "false",
    LANGFUSE_CAPTURE_SYSTEM_PROMPT: "false",
    LANGFUSE_CAPTURE_CWD: "false",
  },
  "full-debug": {
    LANGFUSE_CAPTURE_INPUTS: "true",
    LANGFUSE_CAPTURE_OUTPUTS: "true",
    LANGFUSE_CAPTURE_TOOL_IO: "true",
    LANGFUSE_CAPTURE_SYSTEM_PROMPT: "true",
    LANGFUSE_CAPTURE_CWD: "true",
  },
};

function captureArgs(args: Record<string, string>): Record<string, string | undefined> {
  const capture: Record<string, string | undefined> = {};
  for (const [argName, envName] of CAPTURE_ARG_TO_ENV) {
    if (args[argName] !== undefined) {
      capture[envName] = args[argName];
    }
  }
  return capture;
}

function capturePolicyToPersisted(config: LangfuseConfig | null): Record<string, string> {
  if (!config) {
    return {};
  }
  return {
    LANGFUSE_CAPTURE_INPUTS: String(config.capturePolicy.captureInputs),
    LANGFUSE_CAPTURE_OUTPUTS: String(config.capturePolicy.captureOutputs),
    LANGFUSE_CAPTURE_TOOL_IO: String(config.capturePolicy.captureToolIo),
    LANGFUSE_CAPTURE_SYSTEM_PROMPT: String(config.capturePolicy.captureSystemPrompt),
    LANGFUSE_CAPTURE_CWD: String(config.capturePolicy.captureCwd),
    LANGFUSE_DEBUG: String(config.capturePolicy.debug),
  };
}

function flag(value: boolean): "on" | "off" {
  return value ? "on" : "off";
}

function formatCapturePolicy(config: LangfuseConfig): string[] {
  return [
    `    captureInputs:       ${flag(config.capturePolicy.captureInputs)}`,
    `    captureOutputs:      ${flag(config.capturePolicy.captureOutputs)}`,
    `    captureToolIo:       ${flag(config.capturePolicy.captureToolIo)}`,
    `    captureSystemPrompt: ${flag(config.capturePolicy.captureSystemPrompt)}`,
    `    captureCwd:          ${flag(config.capturePolicy.captureCwd)}`,
  ];
}

function privacyMode(config: LangfuseConfig): string {
  const policy = config.capturePolicy;
  if (
    !policy.captureInputs &&
    !policy.captureOutputs &&
    !policy.captureToolIo &&
    !policy.captureSystemPrompt &&
    !policy.captureCwd
  ) {
    return "minimal metadata (default)";
  }
  if (
    policy.captureInputs &&
    !policy.captureOutputs &&
    !policy.captureToolIo &&
    !policy.captureSystemPrompt &&
    !policy.captureCwd
  ) {
    return "prompts-only";
  }
  if (
    policy.captureInputs &&
    policy.captureOutputs &&
    !policy.captureToolIo &&
    !policy.captureSystemPrompt &&
    !policy.captureCwd
  ) {
    return "conversations";
  }
  if (
    policy.captureInputs &&
    policy.captureOutputs &&
    policy.captureToolIo &&
    policy.captureSystemPrompt &&
    policy.captureCwd
  ) {
    return "full-debug";
  }
  return "custom";
}

function minimalMetadataSummary(): string[] {
  return [
    "    run:        agent, extension, model, provider, sessionId",
    "    generation: model, parameters, usage, cost, status, stop reason, turn index",
    "    tool:       toolName, toolCallId, isError",
  ];
}

function configSource(): string {
  const envConfig = loadConfigFromEnv();
  const fileConfig = loadConfigFromFile();
  if (envConfig && fileConfig) {
    return "environment variables (overrides config file)";
  }
  if (envConfig) {
    return "environment variables";
  }
  if (fileConfig) {
    return "config file";
  }
  return "none";
}

function formatLastError(): string {
  const lastError = getLastError();
  if (!lastError) {
    return "none";
  }
  return `${lastError.scope}: ${lastError.message} (${lastError.timestamp.toISOString()})`;
}

function formatStatus(config: LangfuseConfig | null): string {
  const configPath = configPathForHome();
  if (!config) {
    return [
      `${EXTENSION_NAME} status:`,
      "  State:    not configured",
      "  Action:   Run /langfuse-configure publicKey=... secretKey=...",
      "            Or set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars",
      `  Config file: ${configPath}`,
      `  Last error:  ${formatLastError()}`,
    ].join("\n");
  }

  const safeConfig = sanitizeConfigForLog(config);
  return [
    `${EXTENSION_NAME} status:`,
    "  State:          configured ✓",
    `  Source:         ${configSource()}`,
    `  Host:           ${safeConfig?.host ?? config.host}`,
    `  Public key:     ${safeConfig?.publicKey ?? "[REDACTED_SECRET]"}`,
    "",
    `  Privacy mode:   ${privacyMode(config)}`,
    "  Content capture:",
    ...formatCapturePolicy(config),
    "",
    "  Minimal metadata sent:",
    ...minimalMetadataSummary(),
    "",
    `  Debug:          ${flag(config.capturePolicy.debug)}`,
    `  Config file:    ${configPath}`,
    `  Last error:     ${formatLastError()}`,
  ].join("\n");
}

function summarizeAppliedArgs(parsed: Record<string, string>): string {
  const visible = Object.entries(parsed)
    .filter(([key]) => key !== "secretKey")
    .map(([key, value]) => {
      if (key === "publicKey") {
        const sanitized = sanitizeConfigForLog({
          publicKey: value,
          secretKey: "",
          host: "",
        });
        return `${key}=${sanitized?.publicKey ?? "[REDACTED_SECRET]"}`;
      }
      return `${key}=${value}`;
    });
  return visible.length > 0 ? visible.join(", ") : "no explicit changes";
}

async function testConnectivity(config: LangfuseConfig): Promise<{ ok: boolean; message: string }> {
  const url = `${config.host.replace(/\/+$/, "")}/api/public/projects`;
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      return { ok: true, message: `✓ Connected to ${config.host}` };
    }
    return {
      ok: false,
      message: `✗ ${config.host} returned ${response.status} ${response.statusText}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `✗ Connection failed: ${message}` };
  }
}

function adaptContext(ctx: ExtensionContext): RunContextLike {
  const adapted: RunContextLike = {
    sessionManager: ctx.sessionManager,
  };
  if (ctx.model) {
    adapted.model = { id: ctx.model.id, provider: ctx.model.provider };
  }
  if (typeof ctx.getSystemPrompt === "function") {
    adapted.systemPrompt = ctx.getSystemPrompt();
  }
  return adapted;
}

export default async function lifanhPiLangfuse(pi: ExtensionAPI): Promise<void> {
  let config: LangfuseConfig | null = loadConfig();
  let currentRun: CurrentRun | null = null;
  let hintShown = false;
  let lastErrorNotice: string | null = null;

  pi.registerCommand("langfuse-status", {
    description: "Show @lifanh/pi-langfuse-extension configuration status",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      config = loadConfig();
      notify(ctx, formatStatus(config), config ? "info" : "warning");
    },
  });

  pi.registerCommand("langfuse-configure", {
    description:
      "Persist Langfuse config. Usage: /langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-... [host=https://cloud.langfuse.com] [captureInputs=true]",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parsed = parseConfigureArgs(args);
      const existingFile = loadConfigFromFile();
      const publicKey = parsed["publicKey"] ?? existingFile?.publicKey;
      const secretKey = parsed["secretKey"] ?? existingFile?.secretKey;

      if (!publicKey || !secretKey) {
        notify(
          ctx,
          "No saved config found. Provide publicKey=... secretKey=... or set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.",
          "warning",
        );
        return;
      }

      const mergedCapture = {
        ...capturePolicyToPersisted(existingFile),
        ...captureArgs(parsed),
      };

      saveConfig({
        publicKey,
        secretKey,
        host: parsed["host"] ?? existingFile?.host ?? DEFAULT_LANGFUSE_HOST,
        capture: mergedCapture,
      });
      config = loadConfig();
      notify(
        ctx,
        `${EXTENSION_NAME} config saved. Changes apply on next agent run. Updated: ${summarizeAppliedArgs(parsed)}.`,
      );
    },
  });

  pi.registerCommand("langfuse-test", {
    description: "Test Langfuse connectivity with current config",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      config = loadConfig();
      if (!config) {
        notify(ctx, "Not configured. Run /langfuse-configure first.", "warning");
        return;
      }
      const result = await testConnectivity(config);
      notify(ctx, result.message, result.ok ? "info" : "error");
    },
  });

  pi.registerCommand("langfuse-reset", {
    description: "Remove saved Langfuse configuration",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const configPath = configPathForHome();
      if (!existsSync(configPath)) {
        notify(ctx, "No saved config to reset.", "info");
        return;
      }

      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Reset Langfuse config?",
          `This deletes ${configPath}. Environment variables will still work.`,
        );
        if (!ok) {
          notify(ctx, "Reset cancelled.", "info");
          return;
        }
      }

      unlinkSync(configPath);
      config = loadConfig();
      notify(ctx, "Config file removed. Environment variables will still work.", "info");
    },
  });

  pi.registerCommand("langfuse-privacy", {
    description:
      "Show or update Langfuse privacy flags. Usage: /langfuse-privacy [captureInputs=true] [all=false] [preset=minimal]",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parsed = parseConfigureArgs(args);
      const existingFile = loadConfigFromFile();
      const current = loadConfig();

      if (Object.keys(parsed).length === 0) {
        if (!current) {
          notify(ctx, "Not configured. Run /langfuse-configure first.", "warning");
          return;
        }
        notify(
          ctx,
          [
            `${EXTENSION_NAME} privacy mode: ${privacyMode(current)}`,
            "Content capture:",
            ...formatCapturePolicy(current),
            "",
            "Minimal metadata sent:",
            ...minimalMetadataSummary(),
          ].join("\n"),
          "info",
        );
        return;
      }

      const publicKey = existingFile?.publicKey;
      const secretKey = existingFile?.secretKey;
      if (!publicKey || !secretKey) {
        notify(
          ctx,
          "No saved config file found. Run /langfuse-configure before changing saved privacy flags.",
          "warning",
        );
        return;
      }

      let updates: Record<string, string | undefined> = {};
      if (parsed["preset"] !== undefined) {
        const preset = PRIVACY_PRESETS[parsed["preset"]];
        if (!preset) {
          notify(
            ctx,
            `Unknown preset '${parsed["preset"]}'. Choose one of: ${Object.keys(PRIVACY_PRESETS).join(", ")}.`,
            "warning",
          );
          return;
        }
        updates = { ...updates, ...preset };
      }
      if (parsed["all"] !== undefined) {
        if (parsed["all"] !== "true" && parsed["all"] !== "false") {
          notify(
            ctx,
            `Invalid value for all='${parsed["all"]}'. Use all=true or all=false.`,
            "warning",
          );
          return;
        }
        for (const [, envName] of CAPTURE_ARG_TO_ENV) {
          if (envName !== "LANGFUSE_DEBUG") {
            updates[envName] = parsed["all"];
          }
        }
      }
      updates = { ...updates, ...captureArgs(parsed) };

      if (Object.keys(updates).length === 0) {
        notify(
          ctx,
          "No privacy flags provided. Use captureInputs=true, all=false, or preset=minimal.",
          "warning",
        );
        return;
      }

      saveConfig({
        publicKey,
        secretKey,
        host: existingFile.host,
        capture: { ...capturePolicyToPersisted(existingFile), ...updates },
      });
      config = loadConfig();
      notify(ctx, `${EXTENSION_NAME} privacy settings updated: ${summarizeAppliedArgs(parsed)}.`);
    },
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (hintShown) {
      return;
    }
    hintShown = true;
    config = loadConfig();
    if (!config && ctx.hasUI) {
      ctx.ui.notify(
        `${EXTENSION_NAME}: not configured. Run /langfuse-status for setup instructions.`,
        "info",
      );
    }
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    config = loadConfig();
    if (!config) {
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      return;
    }
    await initTransport(config);
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, isReady() ? "◉ langfuse" : undefined);
    }
    const transportError = getLastError();
    const transportErrorKey = transportError
      ? `${transportError.timestamp.toISOString()}:${transportError.scope}:${transportError.message}`
      : null;
    if (transportError && transportErrorKey !== lastErrorNotice && ctx.hasUI) {
      lastErrorNotice = transportErrorKey;
      ctx.ui.notify(
        `${EXTENSION_NAME}: ${transportError.scope}: ${transportError.message}`,
        "warning",
      );
    }
    const payload = buildRunPayload(event, adaptContext(ctx), config);
    const agentSpan = createAgentSpan("pi-agent-run", payload);
    if (agentSpan) {
      const traceAttrs: TraceAttributes = {
        traceName: "pi-agent-run",
        tags: ["pi-coding-agent"],
        metadata: payload.metadata ?? {},
      };
      if (payload.sessionId) {
        traceAttrs.sessionId = payload.sessionId;
      }
      setTraceAttributes(agentSpan, traceAttrs);
    }
    currentRun = {
      startedAt: new Date(),
      sessionId: payload.sessionId,
      payload,
      tools: new Map(),
      generations: new Map(),
      activeTurnIndex: 0,
      activeMessageEnd: undefined,
      agentSpan,
    };
  });

  pi.on("turn_start", async (event) => {
    if (!currentRun) {
      return;
    }
    currentRun.activeTurnIndex = event.turnIndex;
    currentRun.activeMessageEnd = undefined;
  });

  pi.on("before_provider_request", async (event: BeforeProviderRequestEvent) => {
    if (!currentRun || !config) {
      return;
    }
    const turnIndex = currentRun.activeTurnIndex;
    const payload = buildGenerationPayload(event, undefined, { turnIndex }, undefined, config);
    const generationSpan = createGenerationSpan(
      currentRun.agentSpan,
      `generation:${turnIndex}`,
      payload,
    );
    currentRun.generations.set(turnIndex, {
      turnIndex,
      request: event,
      response: undefined,
      payload,
      generationSpan,
    });
  });

  pi.on("after_provider_response", async (event: ProviderResponseEvent) => {
    if (!currentRun || !config) {
      return;
    }
    const turnIndex = currentRun.activeTurnIndex;
    const existing = currentRun.generations.get(turnIndex);
    const payload = buildGenerationPayload(
      existing?.request,
      event,
      { turnIndex },
      undefined,
      config,
    );
    currentRun.generations.set(turnIndex, {
      turnIndex,
      request: existing?.request,
      response: event,
      payload,
      generationSpan: existing?.generationSpan ?? null,
    });
  });

  pi.on("message_end", async (event: AssistantMessageEndEvent) => {
    if (!currentRun || event.message.role !== "assistant") {
      return;
    }
    currentRun.activeMessageEnd = event;
  });

  pi.on("turn_end", async (event: TurnEndEvent) => {
    if (!currentRun || !config) {
      return;
    }
    const existing = currentRun.generations.get(event.turnIndex);
    const messageEnd = currentRun.activeMessageEnd;
    const payload = buildGenerationPayload(
      existing?.request,
      existing?.response,
      event,
      messageEnd,
      config,
    );
    endGenerationSpan(existing?.generationSpan ?? null, payload);
    currentRun.generations.set(event.turnIndex, {
      turnIndex: event.turnIndex,
      request: existing?.request,
      response: existing?.response,
      payload,
      generationSpan: existing?.generationSpan ?? null,
    });
  });

  pi.on("tool_execution_start", async (event: ToolExecutionStartEvent) => {
    if (!currentRun || !config) {
      return;
    }
    const id = event.toolCallId || String(currentRun.tools.size + 1);
    const payload = buildToolPayload(
      { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args },
      config,
    );
    const toolNameRaw = payload.metadata?.["toolName"];
    const toolName = typeof toolNameRaw === "string" ? toolNameRaw : "tool";
    const toolSpan = createToolSpan(currentRun.agentSpan, `tool:${toolName}`, payload);
    currentRun.tools.set(id, {
      startedAt: new Date(),
      payload,
      toolSpan,
    });
  });

  pi.on("tool_execution_end", async (event: ToolExecutionEndEvent) => {
    if (!currentRun || !config) {
      return;
    }
    const id = event.toolCallId || "";
    const existing = currentRun.tools.get(id);
    const endPayload = buildToolPayload(
      {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      },
      config,
    );
    const previousPayload: CapturedPayload =
      existing?.payload ?? { metadata: undefined };
    const merged: CapturedPayload = { ...previousPayload, ...endPayload };
    endToolSpan(existing?.toolSpan ?? null, merged);
    currentRun.tools.set(id, {
      startedAt: existing?.startedAt ?? new Date(),
      endedAt: new Date(),
      payload: merged,
      toolSpan: existing?.toolSpan ?? null,
    });
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx: ExtensionContext) => {
    if (!currentRun || !config) {
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      return;
    }
    currentRun.endedAt = new Date();
    const rawOutput = config.capturePolicy.captureOutputs
      ? event.messages.at(-1)
      : undefined;
    const output = rawOutput !== undefined ? redactValue(rawOutput) : undefined;
    endAgentSpan(currentRun.agentSpan, output);
    await flush();
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    currentRun = null;
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    if (currentRun?.agentSpan) {
      endAgentSpan(currentRun.agentSpan, undefined);
    }
    await shutdown();
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
    currentRun = null;
  });
}
