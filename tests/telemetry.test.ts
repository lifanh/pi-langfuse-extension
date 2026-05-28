import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGenerationPayload,
  buildRunPayload,
  resolveSessionId,
} from "../src/telemetry.js";
import { createCapturePolicy } from "../src/capture-policy.js";
import type { LangfuseConfig } from "../src/config.js";

function configWithDefaults(): LangfuseConfig {
  return {
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    host: "http://127.0.0.1:9",
    capturePolicy: createCapturePolicy({}),
  };
}

test("resolveSessionId extracts basename without extension from session file", () => {
  const ctx = {
    sessionManager: { getSessionFile: () => "/home/user/.pi/sessions/my-session.json" },
  };
  assert.equal(resolveSessionId(ctx), "my-session");
});

test("resolveSessionId returns undefined for ephemeral sessions", () => {
  const ctx = { sessionManager: { getSessionFile: () => null } };
  assert.equal(resolveSessionId(ctx), undefined);
});

test("resolveSessionId returns undefined when sessionManager is absent", () => {
  assert.equal(resolveSessionId({}), undefined);
});

test("buildRunPayload includes sessionId from ctx.sessionManager", () => {
  const config = configWithDefaults();
  const ctx = {
    sessionManager: { getSessionFile: () => "/sessions/trace-abc123.json" },
  };
  const result = buildRunPayload({}, ctx, config);

  assert.equal(result.sessionId, "trace-abc123");
  assert.equal(result.metadata?.["sessionId"], "trace-abc123");
});

test("buildRunPayload sessionId is undefined without sessionManager", () => {
  const config = configWithDefaults();
  const result = buildRunPayload({}, {}, config);

  assert.equal(result.sessionId, undefined);
});

test("resolveSessionId handles Windows-style paths", () => {
  const ctx = {
    sessionManager: {
      getSessionFile: () => "C:\\Users\\dev\\.pi\\sessions\\win-session.json",
    },
  };
  assert.equal(resolveSessionId(ctx), "win-session");
});

test("buildGenerationPayload captures generation metadata and usage without IO by default", () => {
  const config = configWithDefaults();
  const result = buildGenerationPayload(
    {
      payload: {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "secret prompt" }],
        temperature: 0.2,
        max_tokens: 4096,
      },
    },
    { status: 200, headers: { "x-request-id": "req-123" } },
    {
      turnIndex: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "secret output" }],
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4",
        responseId: "msg-123",
        stopReason: "stop",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 37,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
        },
      },
    },
    undefined,
    config,
  );

  assert.equal(result.input, undefined);
  assert.equal(result.output, undefined);
  assert.equal(result.model, "claude-sonnet-4");
  assert.deepEqual(result.modelParameters, {
    temperature: 0.2,
    max_tokens: 4096,
  });
  assert.deepEqual(result.usageDetails, {
    input: 10,
    output: 20,
    cache_read: 3,
    cache_write: 4,
    total: 37,
  });
  assert.deepEqual(result.costDetails, {
    input: 1,
    output: 2,
    cache_read: 3,
    cache_write: 4,
    total: 10,
  });
  assert.deepEqual(result.metadata, {
    provider: "anthropic",
    api: "anthropic-messages",
    responseId: "msg-123",
    stopReason: "stop",
    turnIndex: 2,
    httpStatus: 200,
    responseHeaders: { "x-request-id": "req-123" },
  });
});

test("buildGenerationPayload captures redacted generation IO when enabled", () => {
  const config = {
    ...configWithDefaults(),
    capturePolicy: createCapturePolicy({
      LANGFUSE_CAPTURE_INPUTS: "true",
      LANGFUSE_CAPTURE_OUTPUTS: "true",
    }),
  };
  const result = buildGenerationPayload(
    {
      payload: {
        model: "gpt-4.1",
        messages: [{ role: "user", content: "token ghp_abcdefghijklmnopqrstuvwxyz123456" }],
      },
    },
    { status: 500, headers: {} },
    {
      turnIndex: 0,
      message: {
        role: "assistant",
        model: "gpt-4.1",
        content: "LANGFUSE_SECRET_KEY=[REDACTED:secret-value]",
        stopReason: "error",
        errorMessage: "provider failed",
      },
    },
    undefined,
    config,
  );

  const input = result.input as { messages: { content: string }[] };
  assert.equal(input.messages[0]?.content, "token [REDACTED_SECRET]");
  assert.equal(result.output, "LANGFUSE_SECRET_KEY=[REDACTED_SECRET]");
  assert.equal(result.isError, true);
  assert.equal(result.statusMessage, "provider failed");
});

test("buildRunPayload preserves system prompt when enabled", () => {
  const config = {
    ...configWithDefaults(),
    capturePolicy: createCapturePolicy({
      LANGFUSE_CAPTURE_SYSTEM_PROMPT: "true",
    }),
  };
  const result = buildRunPayload(
    {},
    { systemPrompt: "system token ghp_abcdefghijklmnopqrstuvwxyz123456" },
    config,
  );

  assert.equal(result.systemPrompt, "system token [REDACTED_SECRET]");
});
