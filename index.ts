import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

/** Pi tool execution events. Re-declared locally because the public package entry
 * does not re-export these event types (they live behind a deep path). */
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
import type { LangfuseAgent, LangfuseTool } from "@langfuse/tracing";

import { loadConfig, sanitizeConfigForLog, type LangfuseConfig } from "./src/config.js";
import { redactValue } from "./src/redaction.js";
import {
  buildRunPayload,
  buildToolPayload,
  type RunContextLike,
  type RunPayload,
} from "./src/telemetry.js";
import type { CapturedPayload } from "./src/capture-policy.js";
import {
  createAgentSpan,
  createToolSpan,
  endAgentSpan,
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

interface CurrentRun {
  startedAt: Date;
  endedAt?: Date;
  sessionId: string | undefined;
  payload: RunPayload;
  tools: Map<string, ToolRun>;
  agentSpan: LangfuseAgent | null;
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

  pi.registerCommand("lifanh-langfuse-status", {
    description: "Show @lifanh/pi-langfuse-extension configuration status",
    handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
      config = loadConfig();
      const safeConfig = sanitizeConfigForLog(config);
      const message = safeConfig
        ? `@lifanh/pi-langfuse-extension configured for ${safeConfig.host} with public key ${safeConfig.publicKey}`
        : "@lifanh/pi-langfuse-extension is not configured. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.";
      if (ctx.hasUI) {
        ctx.ui.notify(message, safeConfig ? "info" : "warning");
      } else {
        console.log(message);
      }
    },
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    config = loadConfig();
    if (!config) {
      return;
    }
    initTransport(config);
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
      agentSpan,
    };
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
