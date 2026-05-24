import test from "node:test";
import assert from "node:assert/strict";

import { createCapturePolicy, applyCapturePolicy } from "../src/capture-policy.js";

test("defaults to metadata-only capture", () => {
  const policy = createCapturePolicy({});
  const result = applyCapturePolicy(
    {
      input: { prompt: "secret prompt" },
      output: "secret output",
      metadata: { model: "claude-sonnet", cwd: "/Users/lifan/private" },
      systemPrompt: "system prompt",
      toolInput: { command: "cat .env" },
      toolOutput: "API_KEY=secret",
    },
    policy,
  );

  assert.equal(result.input, undefined);
  assert.equal(result.output, undefined);
  assert.equal(result.systemPrompt, undefined);
  assert.equal(result.toolInput, undefined);
  assert.equal(result.toolOutput, undefined);
  assert.deepEqual(result.metadata, { model: "claude-sonnet" });
});

test("captures enabled fields after redaction", () => {
  const policy = createCapturePolicy({
    LANGFUSE_CAPTURE_INPUTS: "true",
    LANGFUSE_CAPTURE_OUTPUTS: "true",
    LANGFUSE_CAPTURE_TOOL_IO: "true",
    LANGFUSE_CAPTURE_CWD: "true",
  });

  const result = applyCapturePolicy(
    {
      input: { prompt: "token ghp_abcdefghijklmnopqrstuvwxyz123456" },
      output: "ok",
      metadata: { cwd: "/Users/lifan/private" },
      toolInput: { command: "echo safe" },
      toolOutput: "LANGFUSE_SECRET_KEY=sk-lf-123",
    },
    policy,
  );

  assert.equal(result.input.prompt, "token [REDACTED_SECRET]");
  assert.equal(result.output, "ok");
  assert.match(result.metadata.cwd, /^\[PATH_HASH:[a-f0-9]{12}\]$/);
  assert.deepEqual(result.toolInput, { command: "echo safe" });
  assert.equal(result.toolOutput, "LANGFUSE_SECRET_KEY=[REDACTED_SECRET]");
});
