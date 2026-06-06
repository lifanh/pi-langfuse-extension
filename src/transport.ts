import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startObservation,
  setLangfuseTracerProvider,
  type LangfuseAgent,
  type LangfuseGeneration,
  type LangfuseTool,
  type LangfuseGenerationAttributes,
  type LangfuseSpanAttributes,
  type ObservationLevel,
} from "@langfuse/tracing";

import type { CapturedPayload } from "./capture-policy.js";
import type { LangfuseConfig } from "./config.js";
import type { GenerationPayload } from "./telemetry.js";

let provider: BasicTracerProvider | null = null;
let processor: LangfuseSpanProcessor | null = null;
let transportKey: string | null = null;
let lastError: { scope: string; message: string; timestamp: Date } | null = null;
let traceAttributesByAgentSpan = new WeakMap<
  LangfuseAgent,
  Record<string, string | string[]>
>();

const LOG_PREFIX = "[@lifanh/pi-langfuse-extension]";
const MAX_PROPAGATED_STRING_LENGTH = 200;

function logError(scope: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  lastError = { scope, message, timestamp: new Date() };
  console.error(`${LOG_PREFIX} ${scope}:`, message);
}

export function getLastError(): { scope: string; message: string; timestamp: Date } | null {
  return lastError;
}

export function clearLastError(): void {
  lastError = null;
}

function logDebug(config: LangfuseConfig, message: string): void {
  if (config.capturePolicy.debug) {
    console.debug(`${LOG_PREFIX} ${message}`);
  }
}

function keyForConfig(config: LangfuseConfig): string {
  return JSON.stringify({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    host: config.host,
  });
}

export async function initTransport(config: LangfuseConfig): Promise<void> {
  const nextKey = keyForConfig(config);
  if (provider && transportKey === nextKey) {
    logDebug(config, "transport already initialized");
    return;
  }
  if (provider) {
    await shutdown();
  }
  try {
    processor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.host,
    });
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    setLangfuseTracerProvider(provider);
    transportKey = nextKey;
    clearLastError();
    logDebug(config, `transport initialized for ${config.host}`);
  } catch (err) {
    logError("transport init failed", err);
    provider = null;
    processor = null;
    transportKey = null;
    setLangfuseTracerProvider(null);
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
    if (payload.systemPrompt !== undefined) {
      attributes.metadata = {
        ...(attributes.metadata ?? {}),
        systemPrompt: payload.systemPrompt,
      };
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

function isValidPropagatedString(value: string): boolean {
  return value.length <= MAX_PROPAGATED_STRING_LENGTH;
}

function buildTraceSpanAttributes(
  attrs: TraceAttributes,
): Record<string, string | string[]> {
  const spanAttributes: Record<string, string | string[]> = {};
  if (isValidPropagatedString(attrs.traceName)) {
    spanAttributes["langfuse.trace.name"] = attrs.traceName;
  }
  const tags = attrs.tags?.filter(isValidPropagatedString);
  if (tags && tags.length > 0) {
    spanAttributes["langfuse.trace.tags"] = tags;
  }
  if (attrs.sessionId && isValidPropagatedString(attrs.sessionId)) {
    spanAttributes["session.id"] = attrs.sessionId;
  }
  const metadata = coerceMetadataToStrings(attrs.metadata);
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (isValidPropagatedString(value)) {
        spanAttributes[`langfuse.trace.metadata.${key}`] = value;
      }
    }
  }
  return spanAttributes;
}

function setSpanAttributes(
  observation: LangfuseAgent | LangfuseGeneration | LangfuseTool,
  attrs: Record<string, string | string[]>,
): void {
  for (const [key, value] of Object.entries(attrs)) {
    observation.otelSpan.setAttribute(key, value);
  }
}

function inheritTraceAttributes(
  agentSpan: LangfuseAgent,
  childSpan: LangfuseGeneration | LangfuseTool,
): void {
  const traceAttributes = traceAttributesByAgentSpan.get(agentSpan);
  if (traceAttributes) {
    setSpanAttributes(childSpan, traceAttributes);
  }
}

export function setTraceAttributes(
  agentSpan: LangfuseAgent | null,
  attrs: TraceAttributes,
): void {
  if (!agentSpan) {
    return;
  }
  try {
    const traceAttributes = buildTraceSpanAttributes(attrs);
    traceAttributesByAgentSpan.set(agentSpan, traceAttributes);
    setSpanAttributes(agentSpan, traceAttributes);
  } catch (err) {
    logError("setTraceAttributes failed", err);
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
    const toolSpan = agentSpan.startObservation(name, attributes, {
      asType: "tool",
    });
    inheritTraceAttributes(agentSpan, toolSpan);
    return toolSpan;
  } catch (err) {
    logError("createToolSpan failed", err);
    return null;
  }
}

export function createGenerationSpan(
  agentSpan: LangfuseAgent | null,
  name: string,
  payload: GenerationPayload,
): LangfuseGeneration | null {
  if (!agentSpan) {
    return null;
  }
  try {
    const attributes: LangfuseGenerationAttributes = {};
    if (payload.input !== undefined) {
      attributes.input = payload.input;
    }
    if (payload.metadata !== undefined) {
      attributes.metadata = payload.metadata;
    }
    if (payload.model !== undefined) {
      attributes.model = payload.model;
    }
    if (payload.modelParameters !== undefined) {
      attributes.modelParameters = payload.modelParameters;
    }
    const generationSpan = agentSpan.startObservation(name, attributes, {
      asType: "generation",
    });
    inheritTraceAttributes(agentSpan, generationSpan);
    return generationSpan;
  } catch (err) {
    logError("createGenerationSpan failed", err);
    return null;
  }
}

export function endGenerationSpan(
  generationSpan: LangfuseGeneration | null,
  payload: GenerationPayload,
): void {
  if (!generationSpan) {
    return;
  }
  try {
    const attrs: LangfuseGenerationAttributes = {};
    if (payload.output !== undefined) {
      attrs.output = payload.output;
    }
    if (payload.metadata !== undefined) {
      attrs.metadata = payload.metadata;
    }
    if (payload.model !== undefined) {
      attrs.model = payload.model;
    }
    if (payload.modelParameters !== undefined) {
      attrs.modelParameters = payload.modelParameters;
    }
    if (payload.usageDetails !== undefined) {
      attrs.usageDetails = payload.usageDetails;
    }
    if (payload.costDetails !== undefined) {
      attrs.costDetails = payload.costDetails;
    }
    if (payload.isError) {
      const errorLevel: ObservationLevel = "ERROR";
      attrs.level = errorLevel;
      attrs.statusMessage = payload.statusMessage ?? "generation error";
    }
    generationSpan.update(attrs);
    generationSpan.end();
  } catch (err) {
    logError("endGenerationSpan failed", err);
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
  } catch (err) {
    logError("endToolSpan failed", err);
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
  } catch (err) {
    logError("endAgentSpan failed", err);
  }
}

export async function flush(): Promise<void> {
  if (!processor) {
    return;
  }
  try {
    await processor.forceFlush();
  } catch (err) {
    logError("flush failed", err);
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
  } catch (err) {
    logError("shutdown failed", err);
  } finally {
    provider = null;
    processor = null;
    transportKey = null;
    traceAttributesByAgentSpan = new WeakMap();
    setLangfuseTracerProvider(null);
  }
}
