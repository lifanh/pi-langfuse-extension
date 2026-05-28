import {
  applyCapturePolicy,
  type CapturedPayload,
} from "./capture-policy.js";
import type { LangfuseConfig } from "./config.js";

/** Subset of session manager surface we depend on. */
export interface SessionManagerLike {
  getSessionFile?: () => string | undefined | null;
}

/** Loose context shape accepted from Pi's extension API. */
export interface RunContextLike {
  sessionManager?: SessionManagerLike | undefined;
  model?: { id?: string | undefined; provider?: string | undefined } | undefined;
  systemPrompt?: string | undefined;
}

/** Loose event shape accepted from Pi's before_agent_start. */
export interface RunEventLike {
  prompt?: unknown;
  images?: unknown;
  context?: unknown;
  attachments?: unknown;
  model?: string | undefined;
  provider?: string | undefined;
  systemPromptOptions?: { cwd?: string | undefined } | undefined;
}

export interface RunPayload extends CapturedPayload {
  sessionId: string | undefined;
}

export interface ProviderRequestEventLike {
  payload?: unknown;
}

export interface ProviderResponseEventLike {
  status?: number | undefined;
  headers?: Record<string, string> | undefined;
}

export interface UsageLike {
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
}

export interface AssistantMessageLike {
  role?: string | undefined;
  content?: unknown;
  api?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  responseModel?: string | undefined;
  responseId?: string | undefined;
  usage?: UsageLike | undefined;
  stopReason?: string | undefined;
  errorMessage?: string | undefined;
}

export interface TurnEndEventLike {
  turnIndex?: number | undefined;
  message?: AssistantMessageLike | undefined;
}

export interface MessageEndEventLike {
  message?: AssistantMessageLike | undefined;
}

export interface GenerationPayload extends CapturedPayload {
  model: string | undefined;
  modelParameters: Record<string, string | number> | undefined;
  usageDetails: Record<string, number> | undefined;
  costDetails: Record<string, number> | undefined;
  statusMessage: string | undefined;
  isError: boolean;
}

/** Loose event shape accepted from Pi's tool_execution_start/end. */
export interface ToolEventLike {
  input?: unknown;
  args?: unknown;
  arguments?: unknown;
  params?: unknown;
  output?: unknown;
  result?: unknown;
  content?: unknown;
  error?: unknown;
  toolName?: string | undefined;
  name?: string | undefined;
  toolCallId?: string | undefined;
  id?: string | undefined;
  isError?: boolean | undefined;
}

export function resolveSessionId(ctx: RunContextLike = {}): string | undefined {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (!sessionFile) {
    return undefined;
  }
  const base = sessionFile.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base || undefined;
}

export function buildRunPayload(
  event: RunEventLike = {},
  ctx: RunContextLike = {},
  config: LangfuseConfig | undefined,
): RunPayload {
  const model = event.model ?? ctx.model?.id;
  const provider = event.provider ?? ctx.model?.provider;
  const sessionId = resolveSessionId(ctx);
  const policy = config?.capturePolicy;
  const captured = applyCapturePolicy(
    {
      input: {
        prompt: event.prompt,
        images: event.images,
        context: event.context ?? event.attachments,
      },
      metadata: {
        agent: "pi",
        extension: "@lifanh/pi-langfuse-extension",
        model,
        provider,
        sessionId,
        cwd: event.systemPromptOptions?.cwd ?? process.cwd(),
      },
      systemPrompt: ctx.systemPrompt,
    },
    policy,
  );
  return {
    sessionId,
    ...captured,
  };
}

export function buildToolPayload(
  event: ToolEventLike = {},
  config: LangfuseConfig | undefined,
): CapturedPayload {
  return applyCapturePolicy(
    {
      toolInput: event.input ?? event.args ?? event.arguments ?? event.params,
      toolOutput: event.output ?? event.result ?? event.content ?? event.error,
      metadata: {
        toolName: event.toolName ?? event.name ?? "tool",
        toolCallId: event.toolCallId ?? event.id,
        isError: Boolean(event.isError || event.error),
      },
    },
    config?.capturePolicy,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function modelFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  return firstString(payload["model"], payload["modelId"], payload["deployment"]);
}

function modelParametersFromPayload(
  payload: unknown,
): Record<string, string | number> | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const params: Record<string, string | number> = {};
  for (const key of [
    "temperature",
    "top_p",
    "topP",
    "max_tokens",
    "maxTokens",
    "max_completion_tokens",
    "presence_penalty",
    "frequency_penalty",
    "reasoning_effort",
  ]) {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number") {
      params[key] = value;
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function usageDetailsFromMessage(
  message: AssistantMessageLike | undefined,
): Record<string, number> | undefined {
  const usage = message?.usage;
  if (!usage) {
    return undefined;
  }
  const details: Record<string, number> = {};
  for (const [source, target] of [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cache_read"],
    ["cacheWrite", "cache_write"],
    ["totalTokens", "total"],
  ] as const) {
    const value = usage[source];
    if (typeof value === "number") {
      details[target] = value;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function costDetailsFromMessage(
  message: AssistantMessageLike | undefined,
): Record<string, number> | undefined {
  const cost = message?.usage?.cost;
  if (!cost) {
    return undefined;
  }
  const details: Record<string, number> = {};
  for (const [source, target] of [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cache_read"],
    ["cacheWrite", "cache_write"],
    ["total", "total"],
  ] as const) {
    const value = cost[source];
    if (typeof value === "number") {
      details[target] = value;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

export function buildGenerationPayload(
  request: ProviderRequestEventLike | undefined,
  response: ProviderResponseEventLike | undefined,
  turn: TurnEndEventLike | undefined,
  messageEnd: MessageEndEventLike | undefined,
  config: LangfuseConfig | undefined,
): GenerationPayload {
  const message = turn?.message ?? messageEnd?.message;
  const model = firstString(
    message?.responseModel,
    message?.model,
    modelFromPayload(request?.payload),
  );
  const metadata = {
    provider: message?.provider,
    api: message?.api,
    responseId: message?.responseId,
    stopReason: message?.stopReason,
    turnIndex: turn?.turnIndex,
    httpStatus: response?.status,
    responseHeaders: response?.headers,
  };
  const captured = applyCapturePolicy(
    {
      input: request?.payload,
      output: message?.content,
      metadata,
    },
    config?.capturePolicy,
  );
  return {
    ...captured,
    model,
    modelParameters: modelParametersFromPayload(request?.payload),
    usageDetails: usageDetailsFromMessage(message),
    costDetails: costDetailsFromMessage(message),
    statusMessage: message?.errorMessage,
    isError:
      message?.stopReason === "error" ||
      message?.stopReason === "aborted" ||
      (typeof response?.status === "number" && response.status >= 400),
  };
}
