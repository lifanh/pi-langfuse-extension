import { context, trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  propagateAttributes,
  type LangfuseAgent,
  type LangfuseTool,
  type LangfuseSpanAttributes,
  type ObservationLevel,
} from "@langfuse/tracing";

import type { CapturedPayload } from "./capture-policy.js";
import type { LangfuseConfig } from "./config.js";

let provider: NodeTracerProvider | null = null;
let processor: LangfuseSpanProcessor | null = null;

const LOG_PREFIX = "[@lifanh/pi-langfuse-extension]";

function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${LOG_PREFIX} ${scope}:`, message);
}

export function initTransport(config: LangfuseConfig): void {
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
    logError("transport init failed", err);
    provider = null;
    processor = null;
  }
}

export function isReady(): boolean {
  return provider !== null;
}

export function createAgentSpan(
  name: string,
  payload: CapturedPayload,
): LangfuseAgent | null {
  if (!provider) {
    return null;
  }
  try {
    const attributes: LangfuseSpanAttributes = {};
    if (payload.input !== undefined) {
      attributes.input = payload.input;
    }
    if (payload.metadata !== undefined) {
      attributes.metadata = payload.metadata;
    }
    return startObservation(name, attributes, { asType: "agent" });
  } catch (err) {
    logError("createAgentSpan failed", err);
    return null;
  }
}

export interface TraceAttributes {
  traceName: string;
  tags?: string[];
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

function coerceMetadataToStrings(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      out[key] = value;
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    ) {
      out[key] = String(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function setTraceAttributes(
  agentSpan: LangfuseAgent | null,
  attrs: TraceAttributes,
): void {
  if (!agentSpan) {
    return;
  }
  try {
    const params: Parameters<typeof propagateAttributes>[0] = {
      traceName: attrs.traceName,
    };
    if (attrs.tags) {
      params.tags = attrs.tags;
    }
    if (attrs.sessionId) {
      params.sessionId = attrs.sessionId;
    }
    const metadata = coerceMetadataToStrings(attrs.metadata);
    if (metadata) {
      params.metadata = metadata;
    }
    context.with(trace.setSpan(context.active(), agentSpan.otelSpan), () =>
      propagateAttributes(params, () => {
        // no-op: we only need the attributes to be applied to the current span.
      }),
    );
  } catch {
    // Langfuse failures must not break Pi agent
  }
}

export function createToolSpan(
  agentSpan: LangfuseAgent | null,
  name: string,
  payload: CapturedPayload,
): LangfuseTool | null {
  if (!agentSpan) {
    return null;
  }
  try {
    const attributes: LangfuseSpanAttributes = {};
    if (payload.toolInput !== undefined) {
      attributes.input = payload.toolInput;
    }
    if (payload.metadata !== undefined) {
      attributes.metadata = payload.metadata;
    }
    return agentSpan.startObservation(name, attributes, { asType: "tool" });
  } catch (err) {
    logError("createToolSpan failed", err);
    return null;
  }
}

export function endToolSpan(
  toolSpan: LangfuseTool | null,
  payload: CapturedPayload,
): void {
  if (!toolSpan) {
    return;
  }
  try {
    const attrs: LangfuseSpanAttributes = {};
    if (payload.toolOutput !== undefined) {
      attrs.output = payload.toolOutput;
    }
    if (payload.metadata !== undefined) {
      attrs.metadata = { ...payload.metadata };
    }
    if (payload.metadata && payload.metadata["isError"]) {
      const errorLevel: ObservationLevel = "ERROR";
      attrs.level = errorLevel;
      attrs.statusMessage =
        typeof payload.toolOutput === "string" ? payload.toolOutput : "tool error";
    }
    toolSpan.update(attrs);
    toolSpan.end();
  } catch {
    // Langfuse failures must not break Pi agent
  }
}

export function endAgentSpan(
  agentSpan: LangfuseAgent | null,
  output: unknown,
): void {
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

export async function flush(): Promise<void> {
  if (!processor) {
    return;
  }
  try {
    await processor.forceFlush();
  } catch {
    // Langfuse failures must not break Pi agent
  }
}

export async function shutdown(): Promise<void> {
  if (!provider) {
    return;
  }
  try {
    if (processor) {
      await processor.forceFlush();
    }
    await provider.shutdown();
  } catch {
    // Langfuse failures must not break Pi agent
  } finally {
    provider = null;
    processor = null;
  }
}
