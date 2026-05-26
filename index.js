import { loadConfig, sanitizeConfigForLog } from "./src/config.js";
import { buildRunPayload, buildToolPayload } from "./src/telemetry.js";

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
    const payload = buildRunPayload(event, ctx, config);
    currentRun = {
      startedAt: new Date(),
      sessionId: payload.sessionId,
      payload,
      tools: new Map(),
    };
  });

  pi.on?.("tool_execution_start", async (event) => {
    if (!currentRun || !config) {
      return;
    }
    const id = String(event.toolCallId ?? event.id ?? currentRun.tools.size + 1);
    currentRun.tools.set(id, {
      startedAt: new Date(),
      payload: buildToolPayload(event, config),
    });
  });

  pi.on?.("tool_execution_end", async (event) => {
    if (!currentRun || !config) {
      return;
    }
    const id = String(event.toolCallId ?? event.id ?? "");
    const existing = currentRun.tools.get(id) ?? {};
    currentRun.tools.set(id, {
      ...existing,
      endedAt: new Date(),
      payload: { ...existing.payload, ...buildToolPayload(event, config) },
    });
  });

  pi.on?.("agent_end", async (event) => {
    if (!currentRun || !config) {
      return;
    }
    currentRun.endedAt = new Date();
    currentRun.output = config.capturePolicy.captureOutputs ? event.messages?.at?.(-1) : undefined;
    // Langfuse transport will be added after the privacy/test surface is stable.
    currentRun = null;
  });

  pi.on?.("session_shutdown", async () => {
    currentRun = null;
  });
}
