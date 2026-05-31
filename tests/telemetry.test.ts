import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGenerationPayload,
  buildRunPayload,
  resolveSessionId,
  normalizeContentForLangfuse,
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

// --- normalizeContentForLangfuse ---

test("normalizeContentForLangfuse: returns undefined for undefined content", () => {
  assert.equal(normalizeContentForLangfuse(undefined, undefined), undefined);
});

test("normalizeContentForLangfuse: passes string content through unchanged", () => {
  assert.equal(normalizeContentForLangfuse("hello world", "openai-completions"), "hello world");
});

test("normalizeContentForLangfuse: passes null through unchanged", () => {
  assert.equal(normalizeContentForLangfuse(null, "anthropic-messages"), null);
});

test("normalizeContentForLangfuse: text-only Pi content array becomes plain string", () => {
  const content = [
    { type: "text", text: "Hello " },
    { type: "text", text: "world" },
  ];
  assert.equal(normalizeContentForLangfuse(content, "openai-completions"), "Hello world");
});

test("normalizeContentForLangfuse: thinking-only content array becomes null (no text)", () => {
  const content = [{ type: "thinking", thinking: "some internal thought" }];
  assert.equal(normalizeContentForLangfuse(content, "anthropic-messages"), null);
});

test("normalizeContentForLangfuse: tool calls with no text → OpenAI format for openai-completions", () => {
  const content = [
    { type: "toolCall", id: "call_abc", name: "read", arguments: { path: "/foo/bar.ts" } },
    { type: "toolCall", id: "call_def", name: "bash", arguments: { command: "ls" } },
  ];
  const result = normalizeContentForLangfuse(content, "openai-completions") as Record<string, unknown>;
  assert.equal(result["role"], "assistant");
  assert.equal(result["content"], null);
  const toolCalls = result["tool_calls"] as { id: string; type: string; function: { name: string; arguments: string } }[];
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0]!.id, "call_abc");
  assert.equal(toolCalls[0]!.type, "function");
  assert.equal(toolCalls[0]!.function.name, "read");
  assert.equal(toolCalls[0]!.function.arguments, JSON.stringify({ path: "/foo/bar.ts" }));
  assert.equal(toolCalls[1]!.function.name, "bash");
});

test("normalizeContentForLangfuse: tool calls → OpenAI format for openai-responses", () => {
  const content = [
    { type: "toolCall", id: "tc_1", name: "edit", arguments: { file: "a.ts" } },
  ];
  const result = normalizeContentForLangfuse(content, "openai-responses") as Record<string, unknown>;
  assert.ok(Array.isArray(result["tool_calls"]));
});

test("normalizeContentForLangfuse: tool calls → OpenAI format for unknown/google api", () => {
  const content = [
    { type: "toolCall", id: "tc_1", name: "write", arguments: { path: "x.ts", content: "data" } },
  ];
  const result = normalizeContentForLangfuse(content, "google-generative-ai") as Record<string, unknown>;
  assert.ok(Array.isArray(result["tool_calls"]), "should fall back to OpenAI format");
});

test("normalizeContentForLangfuse: tool calls → Anthropic format for anthropic-messages", () => {
  const content = [
    { type: "toolCall", id: "toolu_01", name: "bash", arguments: { command: "pwd" } },
  ];
  const result = normalizeContentForLangfuse(content, "anthropic-messages") as unknown[];
  assert.ok(Array.isArray(result));
  const toolUse = result[0] as Record<string, unknown>;
  assert.equal(toolUse["type"], "tool_use");
  assert.equal(toolUse["id"], "toolu_01");
  assert.equal(toolUse["name"], "bash");
  assert.deepEqual(toolUse["input"], { command: "pwd" });
});

test("normalizeContentForLangfuse: mixed text+tool calls → OpenAI format preserves text", () => {
  const content = [
    { type: "text", text: "I'll run this for you." },
    { type: "toolCall", id: "call_xyz", name: "bash", arguments: { command: "echo hi" } },
  ];
  const result = normalizeContentForLangfuse(content, "openai-completions") as Record<string, unknown>;
  assert.equal(result["content"], "I'll run this for you.");
  const toolCalls = result["tool_calls"] as { function: { name: string } }[];
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0]!.function.name, "bash");
});

test("normalizeContentForLangfuse: mixed text+tool calls → Anthropic format preserves both", () => {
  const content = [
    { type: "text", text: "Let me check that." },
    { type: "toolCall", id: "toolu_02", name: "read", arguments: { path: "README.md" } },
  ];
  const result = normalizeContentForLangfuse(content, "anthropic-messages") as unknown[];
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  const textBlock = result[0] as Record<string, unknown>;
  const toolUse = result[1] as Record<string, unknown>;
  assert.equal(textBlock["type"], "text");
  assert.equal(textBlock["text"], "Let me check that.");
  assert.equal(toolUse["type"], "tool_use");
  assert.equal(toolUse["name"], "read");
});

test("normalizeContentForLangfuse: provider-native arrays pass through unchanged", () => {
  const content = [
    { type: "text", text: "Let me check that." },
    { type: "tool_use", id: "toolu_03", name: "read", input: { path: "README.md" } },
  ];

  assert.strictEqual(normalizeContentForLangfuse(content, "anthropic-messages"), content);
});

test("buildGenerationPayload: tool calls in output are normalized to OpenAI format when captureOutputs enabled", () => {
  const config = {
    ...configWithDefaults(),
    capturePolicy: createCapturePolicy({ LANGFUSE_CAPTURE_OUTPUTS: "true" }),
  };
  const result = buildGenerationPayload(
    undefined,
    undefined,
    {
      turnIndex: 1,
      message: {
        role: "assistant",
        api: "openai-completions",
        model: "gpt-4o",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/foo.ts" } },
        ],
        stopReason: "tool_calls",
        usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    },
    undefined,
    config,
  );
  const output = result.output as Record<string, unknown>;
  assert.ok(Array.isArray(output["tool_calls"]), "output should have tool_calls array");
  const toolCalls = output["tool_calls"] as { function: { name: string } }[];
  assert.equal(toolCalls[0]!.function.name, "read");
});

test("buildGenerationPayload: tool calls in output are normalized to Anthropic format when captureOutputs enabled", () => {
  const config = {
    ...configWithDefaults(),
    capturePolicy: createCapturePolicy({ LANGFUSE_CAPTURE_OUTPUTS: "true" }),
  };
  const result = buildGenerationPayload(
    undefined,
    undefined,
    {
      turnIndex: 0,
      message: {
        role: "assistant",
        api: "anthropic-messages",
        model: "claude-opus-4-5",
        content: [
          { type: "toolCall", id: "toolu_99", name: "bash", arguments: { command: "ls" } },
        ],
        stopReason: "tool_use",
        usage: { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    },
    undefined,
    config,
  );
  const output = result.output as unknown[];
  assert.ok(Array.isArray(output), "Anthropic output should be an array");
  const toolUse = output[0] as Record<string, unknown>;
  assert.equal(toolUse["type"], "tool_use");
  assert.equal(toolUse["name"], "bash");
});
