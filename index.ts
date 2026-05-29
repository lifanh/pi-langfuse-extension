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
  loadConfig,
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
  initTransport,
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

function captureArgs(args: Record<string, string>): Record<string, string | undefined> {
  const capture: Record<string, string | undefined> = {};
  for (const [argName, envName] of [
    ["captureInputs", "LANGFUSE_CAPTURE_INPUTS"],
    ["captureOutputs", "LANGFUSE_CAPTURE_OUTPUTS"],
    ["captureToolIo", "LANGFUSE_CAPTURE_TOOL_IO"],
    ["captureSystemPrompt", "LANGFUSE_CAPTURE_SYSTEM_PROMPT"],
    ["captureCwd", "LANGFUSE_CAPTURE_CWD"],
    ["debug", "LANGFUSE_DEBUG"],
  ] as const) {
    if (args[argName] !== undefined) {
      capture[envName] = args[argName];
    }
  }
  return capture;
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

  pi.registerCommand("langfuse-status", {
    description: "Show @lifanh/pi-langfuse-extension configuration status",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      config = loadConfig();
      const safeConfig = sanitizeConfigForLog(config);
      const message = safeConfig
        ? `@lifanh/pi-langfuse-extension configured for ${safeConfig.host} with public key ${safeConfig.publicKey}`
        : "@lifanh/pi-langfuse-extension is not configured. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.";
      notify(ctx, message, safeConfig ? "info" : "warning");
    },
  });

  pi.registerCommand("langfuse-configure", {
    description:
      "Persist Langfuse config. Usage: /langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-... [host=https://cloud.langfuse.com] [captureInputs=true]",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const parsed = parseConfigureArgs(args);
      if (!parsed["publicKey"] || !parsed["secretKey"]) {
        notify(
          ctx,
          "Usage: /langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-... [host=https://cloud.langfuse.com]",
          "warning",
        );
        return;
      }
      const persistInput = {
        publicKey: parsed["publicKey"],
        secretKey: parsed["secretKey"],
        capture: captureArgs(parsed),
      };
      saveConfig(
        parsed["host"]
          ? { ...persistInput, host: parsed["host"] }
          : persistInput,
      );
      config = loadConfig();
      notify(ctx, "@lifanh/pi-langfuse-extension config saved.");
    },
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    config = loadConfig();
    if (!config) {
      return;
    }
    await initTransport(config);
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

  pi.on("agent_end", async (event: AgentEndEvent) => {
    if (!currentRun || !config) {
      return;
    }
    currentRun.endedAt = new Date();
    const rawOutput = config.capturePolicy.captureOutputs
      ? event.messages.at(-1)
      : undefined;
    const output = rawOutput !== undefined ? redactValue(rawOutput) : undefined;
    endAgentSpan(currentRun.agentSpan, output);
    await flush();
    currentRun = null;
  });

  pi.on("session_shutdown", async () => {
    if (currentRun?.agentSpan) {
      endAgentSpan(currentRun.agentSpan, undefined);
    }
    await shutdown();
    currentRun = null;
  });
}
