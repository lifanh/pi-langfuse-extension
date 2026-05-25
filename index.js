import { loadConfig, sanitizeConfigForLog } from "./src/config.js";
import { buildRunPayload, buildToolPayload } from "./src/telemetry.js";
import {
  initTransport,
  isReady,
  createAgentSpan,
  setTraceAttributes,
  createToolSpan,
  endToolSpan,
  endAgentSpan,
  flush,
  shutdown,
} from "./src/transport.js";

export default async function lifanhPiLangfuse(pi) {
  let config = loadConfig();
  let currentRun = null;

  pi.registerCommand?.("lifanh-langfuse-status", {
    description: "Show @lifanh/pi-langfuse-extension configuration status",
    handler: async (_args, ctx) => {
      config = loadConfig();
      const safeConfig = sanitizeConfigForLog(config);
      const message = safeConfig
        ? `@lifanh/pi-langfuse-extension configured for ${safeConfig.host} with public key ${safeConfig.publicKey}`
        : "@lifanh/pi-langfuse-extension is not configured. Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.";
      ctx?.ui?.notify?.(message, safeConfig ? "info" : "warning");
      if (!ctx?.ui) {
        console.log(message);
      }
    },
  });

  pi.on?.("before_agent_start", async (event, ctx) => {
    config = loadConfig();
    if (!config) {
      return;
    }
    initTransport(config);
    const payload = buildRunPayload(event, ctx, config);
    const agentSpan = createAgentSpan("pi-agent-run", payload);
    if (agentSpan) {
      setTraceAttributes(agentSpan, {
        traceName: "pi-agent-run",
        tags: ["pi-coding-agent"],
        metadata: payload.metadata ?? {},
      });
    }
    currentRun = {
      startedAt: new Date(),
      payload,
      tools: new Map(),
      agentSpan,
    };
  });

  pi.on?.("tool_execution_start", async (event) => {
    if (!currentRun || !config) {
      return;
    }
    const id = String(event.toolCallId ?? event.id ?? currentRun.tools.size + 1);
    const payload = buildToolPayload(event, config);
    const toolName = payload.metadata?.toolName ?? "tool";
    const toolSpan = createToolSpan(currentRun.agentSpan, `tool:${toolName}`, payload);
    currentRun.tools.set(id, {
      startedAt: new Date(),
      payload,
      toolSpan,
    });
  });

  pi.on?.("tool_execution_end", async (event) => {
    if (!currentRun || !config) {
      return;
    }
    const id = String(event.toolCallId ?? event.id ?? "");
    const existing = currentRun.tools.get(id) ?? {};
    const endPayload = buildToolPayload(event, config);
    const merged = { ...existing.payload, ...endPayload };
    endToolSpan(existing.toolSpan, merged);
    currentRun.tools.set(id, {
      ...existing,
      endedAt: new Date(),
      payload: merged,
    });
  });

  pi.on?.("agent_end", async (event) => {
    if (!currentRun || !config) {
      return;
    }
    currentRun.endedAt = new Date();
    const output = config.capturePolicy.captureOutputs ? event.messages?.at?.(-1) : undefined;
    endAgentSpan(currentRun.agentSpan, output);
    await flush();
    currentRun = null;
  });

  pi.on?.("session_shutdown", async () => {
    if (currentRun?.agentSpan) {
      endAgentSpan(currentRun.agentSpan, undefined);
    }
    await shutdown();
    currentRun = null;
  });
}
