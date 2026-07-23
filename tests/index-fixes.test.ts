import test from "node:test";
import assert from "node:assert/strict";

import lifanhPiLangfuse, {
  shouldSupersedeGeneration,
  supersedeGenerationPayload,
  collectDanglingSpans,
  findUnendedToolRunId,
  lastAssistantMessage,
} from "../index.js";
import type { CapturedPayload } from "../src/capture-policy.js";
import type { GenerationPayload } from "../src/telemetry.js";
import type { LangfuseGeneration, LangfuseTool } from "@langfuse/tracing";

interface HandlerMap {
  [event: string]: ((event?: unknown, ctx?: unknown) => Promise<void>) | undefined;
}

async function withTestEnv<T>(
  overrides: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(overrides);
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    process.env[key] = overrides[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function fakeGenerationSpan(): LangfuseGeneration {
  // Only used as an opaque truthy/falsy marker by the code under test; never invoked.
  return {} as unknown as LangfuseGeneration;
}

function fakeToolSpan(): LangfuseTool {
  return {} as unknown as LangfuseTool;
}

function generationPayload(overrides: Partial<GenerationPayload> = {}): GenerationPayload {
  return {
    metadata: { turnIndex: 0 },
    model: "claude-sonnet-4",
    modelParameters: undefined,
    usageDetails: undefined,
    costDetails: undefined,
    statusMessage: undefined,
    isError: false,
    ...overrides,
  };
}

function toolPayload(overrides: Partial<CapturedPayload> = {}): CapturedPayload {
  return {
    metadata: { toolName: "shell" },
    ...overrides,
  };
}

// --- shouldSupersedeGeneration ---------------------------------------------------------

test("shouldSupersedeGeneration: undefined existing run never supersedes", () => {
  assert.equal(shouldSupersedeGeneration(undefined), false);
});

test("shouldSupersedeGeneration: no span to leak means nothing to supersede", () => {
  assert.equal(shouldSupersedeGeneration({ generationSpan: null, ended: false }), false);
});

test("shouldSupersedeGeneration: already-ended span is not superseded again", () => {
  assert.equal(
    shouldSupersedeGeneration({ generationSpan: fakeGenerationSpan(), ended: true }),
    false,
  );
});

test("shouldSupersedeGeneration: live span from a same-turn retry must be superseded", () => {
  assert.equal(
    shouldSupersedeGeneration({ generationSpan: fakeGenerationSpan(), ended: false }),
    true,
  );
});

// --- supersedeGenerationPayload ---------------------------------------------------------

test("supersedeGenerationPayload marks metadata without dropping other fields", () => {
  const payload = generationPayload({ metadata: { turnIndex: 2 }, model: "gpt-5" });
  const result = supersedeGenerationPayload(payload);
  assert.equal(result.model, "gpt-5");
  assert.equal(result.metadata?.["turnIndex"], 2);
  assert.equal(result.metadata?.["supersededByRetry"], true);
});

test("supersedeGenerationPayload tolerates missing metadata", () => {
  const payload = generationPayload({ metadata: undefined });
  const result = supersedeGenerationPayload(payload);
  assert.deepEqual(result.metadata, { supersededByRetry: true });
});

// --- collectDanglingSpans ---------------------------------------------------------------

test("collectDanglingSpans: ended tools and generations are not collected", () => {
  const tools = new Map([
    [
      "1",
      {
        startedAt: new Date(),
        endedAt: new Date(),
        payload: toolPayload(),
        toolSpan: fakeToolSpan(),
      },
    ],
  ]);
  const generations = new Map([
    [
      0,
      {
        turnIndex: 0,
        request: undefined,
        response: undefined,
        payload: generationPayload(),
        generationSpan: fakeGenerationSpan(),
        ended: true,
      },
    ],
  ]);

  const dangling = collectDanglingSpans({ tools, generations });
  assert.equal(dangling.tools.length, 0);
  assert.equal(dangling.generations.length, 0);
});

test("collectDanglingSpans: unended tool with a live span is collected and marked interrupted", () => {
  const span = fakeToolSpan();
  const tools = new Map([
    [
      "1",
      {
        startedAt: new Date(),
        payload: toolPayload({ toolOutput: undefined }),
        toolSpan: span,
      },
    ],
  ]);
  const dangling = collectDanglingSpans({ tools, generations: new Map() });
  assert.equal(dangling.tools.length, 1);
  assert.equal(dangling.tools[0]?.span, span);
  assert.equal(dangling.tools[0]?.payload.metadata?.["interrupted"], true);
  assert.equal(dangling.tools[0]?.payload.metadata?.["toolName"], "shell");
});

test("collectDanglingSpans: a tool with no span is skipped even if unended", () => {
  const tools = new Map([
    ["1", { startedAt: new Date(), payload: toolPayload(), toolSpan: null }],
  ]);
  const dangling = collectDanglingSpans({ tools, generations: new Map() });
  assert.equal(dangling.tools.length, 0);
});

test("collectDanglingSpans: unended generation with a live span is collected and marked interrupted", () => {
  const span = fakeGenerationSpan();
  const generations = new Map([
    [
      0,
      {
        turnIndex: 0,
        request: undefined,
        response: undefined,
        payload: generationPayload({ model: "claude-sonnet-4" }),
        generationSpan: span,
        ended: false,
      },
    ],
  ]);
  const dangling = collectDanglingSpans({ tools: new Map(), generations });
  assert.equal(dangling.generations.length, 1);
  assert.equal(dangling.generations[0]?.span, span);
  assert.equal(dangling.generations[0]?.payload.model, "claude-sonnet-4");
  assert.equal(dangling.generations[0]?.payload.metadata?.["interrupted"], true);
});

test("collectDanglingSpans: falls back to an empty payload when the generation has none", () => {
  const span = fakeGenerationSpan();
  const generations = new Map([
    [
      0,
      {
        turnIndex: 0,
        request: undefined,
        response: undefined,
        payload: undefined,
        generationSpan: span,
        ended: false,
      },
    ],
  ]);
  const dangling = collectDanglingSpans({ tools: new Map(), generations });
  assert.equal(dangling.generations.length, 1);
  assert.equal(dangling.generations[0]?.payload.metadata?.["interrupted"], true);
  assert.equal(dangling.generations[0]?.payload.isError, false);
});

// --- findUnendedToolRunId ----------------------------------------------------------------

test("findUnendedToolRunId: matches the unended run with the same tool name", () => {
  const tools = new Map([
    [
      "1",
      {
        startedAt: new Date(),
        endedAt: new Date(),
        payload: toolPayload({ metadata: { toolName: "shell" } }),
        toolSpan: null,
      },
    ],
    [
      "2",
      {
        startedAt: new Date(),
        payload: toolPayload({ metadata: { toolName: "shell" } }),
        toolSpan: null,
      },
    ],
  ]);
  assert.equal(findUnendedToolRunId(tools, "shell"), "2");
});

test("findUnendedToolRunId: ignores runs for a different tool name", () => {
  const tools = new Map([
    [
      "1",
      {
        startedAt: new Date(),
        payload: toolPayload({ metadata: { toolName: "read_file" } }),
        toolSpan: null,
      },
    ],
  ]);
  assert.equal(findUnendedToolRunId(tools, "shell"), undefined);
});

test("findUnendedToolRunId: picks the most recently started match when several are unended", () => {
  const tools = new Map([
    [
      "a",
      {
        startedAt: new Date(),
        payload: toolPayload({ metadata: { toolName: "shell" } }),
        toolSpan: null,
      },
    ],
    [
      "b",
      {
        startedAt: new Date(),
        payload: toolPayload({ metadata: { toolName: "shell" } }),
        toolSpan: null,
      },
    ],
  ]);
  assert.equal(findUnendedToolRunId(tools, "shell"), "b");
});

test("findUnendedToolRunId: returns undefined for an empty map", () => {
  assert.equal(findUnendedToolRunId(new Map(), "shell"), undefined);
});

// --- lastAssistantMessage -----------------------------------------------------------------

test("lastAssistantMessage: undefined messages yields undefined", () => {
  assert.equal(lastAssistantMessage(undefined), undefined);
});

test("lastAssistantMessage: returns the trailing assistant message unchanged", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hello" }], api: "anthropic-messages" },
  ];
  const result = lastAssistantMessage(messages);
  assert.equal(result?.api, "anthropic-messages");
  assert.deepEqual(result?.content, [{ type: "text", text: "hello" }]);
});

test("lastAssistantMessage: skips a trailing tool-result message to find the assistant turn", () => {
  const messages = [
    { role: "user", content: "run ls" },
    { role: "assistant", content: [{ type: "text", text: "running" }], api: "openai-responses" },
    { role: "toolResult", content: [{ type: "text", text: "file1\nfile2" }] },
  ];
  const result = lastAssistantMessage(messages);
  assert.equal(result?.api, "openai-responses");
});

test("lastAssistantMessage: skips a trailing custom/bash-execution message", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "done" }], api: "anthropic-messages" },
    { role: "bashExecution", command: "echo hi", output: "hi" },
  ];
  const result = lastAssistantMessage(messages);
  assert.equal(result?.api, "anthropic-messages");
});

test("lastAssistantMessage: returns undefined when no assistant message exists", () => {
  const messages = [{ role: "user", content: "hi" }, { role: "toolResult", content: [] }];
  assert.equal(lastAssistantMessage(messages), undefined);
});

// --- Wiring regression: drive the real event handlers end to end -----------------------
//
// The unit tests above pin down each fix's logic; this drives lifanhPiLangfuse's actual
// pi.on(...) handlers through the buggy scenarios (same-turn retry, a toolCallId-less
// tool call, and a non-assistant trailing message at agent_end) to guard against wiring
// regressions the pure-helper tests can't see. It points at an unreachable host so
// flush()/shutdown() fail closed (caught and logged by src/transport.ts) instead of
// making network calls.

test("integration: retry, missing toolCallId, and trailing non-assistant message do not throw", async () => {
  await withTestEnv(
    {
      LANGFUSE_PUBLIC_KEY: "pk-lf-test",
      LANGFUSE_SECRET_KEY: "sk-lf-test",
      LANGFUSE_HOST: "http://127.0.0.1:9",
      LANGFUSE_CAPTURE_OUTPUTS: "true",
      LANGFUSE_CAPTURE_TOOL_IO: "true",
    },
    async () => {
      const handlers: HandlerMap = {};
      const pi = {
        registerCommand: () => {},
        on: (event: string, handler: (event?: unknown, ctx?: unknown) => Promise<void>) => {
          handlers[event] = handler;
        },
      };
      await lifanhPiLangfuse(pi as never);

      const ctx = {
        hasUI: false,
        sessionManager: { getSessionFile: () => "/tmp/index-fixes-integration.json" },
        model: { id: "test-model", provider: "test-provider" },
        getSystemPrompt: () => "system prompt",
      };

      await handlers.before_agent_start?.(
        {
          type: "before_agent_start",
          prompt: "hi",
          systemPromptOptions: { cwd: process.cwd() },
        },
        ctx,
      );
      await handlers.turn_start?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });

      // Fix 1: a same-turn retry must not throw (and must not leak the first span).
      await handlers.before_provider_request?.({
        type: "before_provider_request",
        payload: { model: "test-model", messages: [], temperature: 0.1 },
      });
      await handlers.before_provider_request?.({
        type: "before_provider_request",
        payload: { model: "test-model", messages: [], temperature: 0.1 },
      });
      await handlers.after_provider_response?.({
        type: "after_provider_response",
        status: 200,
        headers: {},
      });

      // Fix 3: start and end both omit toolCallId; end must still find the started run.
      await handlers.tool_execution_start?.({
        type: "tool_execution_start",
        toolCallId: "",
        toolName: "shell",
        args: { command: "ls" },
      });
      await handlers.tool_execution_end?.({
        type: "tool_execution_end",
        toolCallId: "",
        toolName: "shell",
        result: "ok",
        isError: false,
      });

      const assistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "anthropic-messages",
        provider: "test-provider",
        model: "test-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      await handlers.message_end?.({ type: "message_end", message: assistantMessage });
      await handlers.turn_end?.({
        type: "turn_end",
        turnIndex: 0,
        message: assistantMessage,
        toolResults: [],
      });

      // Fix 4: agent_end's last message is a tool result, not the assistant reply.
      await handlers.agent_end?.(
        {
          type: "agent_end",
          messages: [
            assistantMessage,
            {
              role: "toolResult",
              toolCallId: "trailing-tool",
              toolName: "shell",
              content: [],
              isError: false,
              timestamp: Date.now(),
            },
          ],
        },
        ctx,
      );

      // Fix 2: session_shutdown must close a still-open run without throwing. Start a
      // fresh run and leave a tool span dangling (no tool_execution_end) to exercise it.
      await handlers.before_agent_start?.(
        {
          type: "before_agent_start",
          prompt: "hi again",
          systemPromptOptions: { cwd: process.cwd() },
        },
        ctx,
      );
      await handlers.turn_start?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
      await handlers.tool_execution_start?.({
        type: "tool_execution_start",
        toolCallId: "dangling-1",
        toolName: "shell",
        args: { command: "sleep 100" },
      });
      await handlers.session_shutdown?.(undefined, ctx);
    },
  );
});
