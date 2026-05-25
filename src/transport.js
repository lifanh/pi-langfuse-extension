import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, propagateAttributes } from "@langfuse/tracing";

let provider = null;
let processor = null;

export function initTransport(config) {
  if (provider) {
    return;
  }
  try {
    processor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.host,
    });
    provider = new NodeTracerProvider({ spanProcessors: [processor] });
    provider.register();
  } catch (err) {
    console.error("[@lifanh/pi-langfuse-extension] transport init failed:", err?.message ?? err);
    provider = null;
    processor = null;
  }
}

export function isReady() {
  return provider !== null;
}

export function createAgentSpan(name, payload) {
  if (!provider) {
    return null;
  }
  try {
    const attributes = {};
    if (payload.input) {
      attributes.input = payload.input;
    }
    if (payload.metadata) {
      attributes.metadata = payload.metadata;
    }
    return startObservation(name, attributes, { asType: "agent" });
  } catch (err) {
    console.error("[@lifanh/pi-langfuse-extension] createAgentSpan failed:", err?.message ?? err);
    return null;
  }
}

export function setTraceAttributes(agentSpan, attrs) {
  if (!agentSpan) {
    return;
  }
  try {
    context.with(
      trace.setSpan(context.active(), agentSpan.otelSpan),
      () => propagateAttributes(attrs, () => {}),
    );
  } catch {
    // Langfuse failures must not break Pi agent
  }
}

export function createToolSpan(agentSpan, name, payload) {
  if (!agentSpan) {
    return null;
  }
  try {
    const attributes = {};
    if (payload.toolInput) {
      attributes.input = payload.toolInput;
    }
    if (payload.metadata) {
      attributes.metadata = payload.metadata;
    }
    return agentSpan.startObservation(name, attributes, { asType: "tool" });
  } catch (err) {
    console.error("[@lifanh/pi-langfuse-extension] createToolSpan failed:", err?.message ?? err);
    return null;
  }
}

export function endToolSpan(toolSpan, payload) {
  if (!toolSpan) {
    return;
  }
  try {
    const attrs = {};
    if (payload.toolOutput) {
      attrs.output = payload.toolOutput;
    }
    if (payload.metadata) {
      attrs.metadata = { ...payload.metadata };
    }
    if (payload.metadata?.isError) {
      attrs.level = "ERROR";
      attrs.statusMessage = typeof payload.toolOutput === "string" ? payload.toolOutput : "tool error";
    }
    toolSpan.update(attrs);
    toolSpan.end();
  } catch {
    // Langfuse failures must not break Pi agent
  }
}

export function endAgentSpan(agentSpan, output) {
  if (!agentSpan) {
    return;
  }
  try {
    if (output !== undefined) {
      agentSpan.update({ output });
    }
    agentSpan.end();
  } catch {
    // Langfuse failures must not break Pi agent
  }
}

export async function flush() {
  if (!processor) {
    return;
  }
  try {
    await processor.forceFlush();
  } catch {
    // Langfuse failures must not break Pi agent
  }
}

export async function shutdown() {
  if (!provider) {
    return;
  }
  try {
    await processor.forceFlush();
    await provider.shutdown();
  } catch {
    // Langfuse failures must not break Pi agent
  } finally {
    provider = null;
    processor = null;
  }
}
