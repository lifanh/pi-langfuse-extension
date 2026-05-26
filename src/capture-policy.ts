import { redactValue } from "./redaction.js";

export interface CapturePolicy {
  readonly captureInputs: boolean;
  readonly captureOutputs: boolean;
  readonly captureToolIo: boolean;
  readonly captureSystemPrompt: boolean;
  readonly captureCwd: boolean;
  readonly debug: boolean;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

function envFlag(env: EnvLike, name: string, defaultValue = false): boolean {
  const value = env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function createCapturePolicy(
  env: EnvLike = process.env as EnvLike,
): CapturePolicy {
  return {
    captureInputs: envFlag(env, "LANGFUSE_CAPTURE_INPUTS"),
    captureOutputs: envFlag(env, "LANGFUSE_CAPTURE_OUTPUTS"),
    captureToolIo: envFlag(env, "LANGFUSE_CAPTURE_TOOL_IO"),
    captureSystemPrompt: envFlag(env, "LANGFUSE_CAPTURE_SYSTEM_PROMPT"),
    captureCwd: envFlag(env, "LANGFUSE_CAPTURE_CWD"),
    debug: envFlag(env, "LANGFUSE_DEBUG"),
  };
}

export interface RawPayload {
  input?: unknown;
  output?: unknown;
  toolInput?: unknown;
  toolOutput?: unknown;
  systemPrompt?: unknown;
  metadata?: Record<string, unknown> | undefined;
}

export interface CapturedPayload {
  metadata: Record<string, unknown> | undefined;
  input?: unknown;
  output?: unknown;
  toolInput?: unknown;
  toolOutput?: unknown;
  systemPrompt?: unknown;
}

function filterMetadata(
  metadata: Record<string, unknown> | undefined,
  policy: CapturePolicy,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "cwd" && !policy.captureCwd) {
      continue;
    }
    output[key] = redactValue(value);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function applyCapturePolicy(
  payload: RawPayload,
  policy: CapturePolicy = createCapturePolicy(),
): CapturedPayload {
  const output: CapturedPayload = {
    metadata: filterMetadata(payload.metadata, policy),
  };

  if (policy.captureInputs && "input" in payload) {
    output.input = redactValue(payload.input);
  }
  if (policy.captureOutputs && "output" in payload) {
    output.output = redactValue(payload.output);
  }
  if (policy.captureToolIo && "toolInput" in payload) {
    output.toolInput = redactValue(payload.toolInput);
  }
  if (policy.captureToolIo && "toolOutput" in payload) {
    output.toolOutput = redactValue(payload.toolOutput);
  }
  if (policy.captureSystemPrompt && "systemPrompt" in payload) {
    output.systemPrompt = redactValue(payload.systemPrompt);
  }

  return output;
}
