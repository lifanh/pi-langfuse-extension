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
