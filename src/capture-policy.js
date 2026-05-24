import { redactValue } from "./redaction.js";

function envFlag(env, name, defaultValue = false) {
  const value = env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function createCapturePolicy(env = process.env) {
  return {
    captureInputs: envFlag(env, "LANGFUSE_CAPTURE_INPUTS"),
    captureOutputs: envFlag(env, "LANGFUSE_CAPTURE_OUTPUTS"),
    captureToolIo: envFlag(env, "LANGFUSE_CAPTURE_TOOL_IO"),
    captureSystemPrompt: envFlag(env, "LANGFUSE_CAPTURE_SYSTEM_PROMPT"),
    captureCwd: envFlag(env, "LANGFUSE_CAPTURE_CWD"),
    debug: envFlag(env, "LANGFUSE_DEBUG"),
  };
}

function filterMetadata(metadata, policy) {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }

  const output = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "cwd" && !policy.captureCwd) {
      continue;
    }
    output[key] = redactValue(value);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function applyCapturePolicy(payload, policy = createCapturePolicy()) {
  const output = {
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
