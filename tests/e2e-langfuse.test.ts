import test from "node:test";
import assert from "node:assert/strict";

import lifanhPiLangfuse from "../index.js";

interface HandlerMap {
  [event: string]: ((event?: unknown, ctx?: unknown) => Promise<void>) | undefined;
}

interface ObservationListItem {
  id: string;
  traceId: string;
  type?: string;
  parentObservationId?: string | null;
  input?: string | null;
  output?: string | null;
  metadata?: Record<string, unknown>;
}

function shouldRunE2e(): boolean {
  return process.env["RUN_LANGFUSE_E2E"] === "true";
}

function langfuseHost(): string {
  return (
    process.env["LANGFUSE_HOST"] ||
    process.env["LANGFUSE_BASE_URL"] ||
    "https://cloud.langfuse.com"
  );
}

async function langfuseGet<T>(path: string): Promise<T> {
  const publicKey = process.env["LANGFUSE_PUBLIC_KEY"];
  const secretKey = process.env["LANGFUSE_SECRET_KEY"];
  assert.ok(publicKey, "LANGFUSE_PUBLIC_KEY is required");
  assert.ok(secretKey, "LANGFUSE_SECRET_KEY is required");
  const base = langfuseHost().replace(/\/$/, "");
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  const body = await response.text();
  assert.equal(
    response.ok,
    true,
    `Langfuse API ${path} failed with ${response.status}: ${body}`,
  );
  return JSON.parse(body) as T;
}

async function waitForObservations(sessionId: string, started: Date) {
  const query = new URLSearchParams({
    filter: JSON.stringify([{ type: "string", column: "sessionId", operator: "=", value: sessionId }]),
    fields: "core,basic,io,metadata",
    fromStartTime: started.toISOString(),
    toStartTime: new Date(Date.now() + 1000).toISOString(),
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { data } = await langfuseGet<{ data: ObservationListItem[] }>(`/api/public/v2/observations?${query}`);
    const agent = data.find((obs) => obs.type === "AGENT");
    const generation = data.find((obs) => obs.type === "GENERATION");
    const tool = data.find((obs) => obs.type === "TOOL");
    if (agent && generation && tool) {
      return { agent, generation, tool };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Missing agent, generation or tool observation for session ${sessionId}`);
}

test("e2e: sends agent, generation, and tool observations to Langfuse", async (t) => {
  if (!shouldRunE2e()) {
    t.skip("set RUN_LANGFUSE_E2E=true to hit a real Langfuse project");
    return;
  }
  assert.ok(process.env["LANGFUSE_PUBLIC_KEY"]);
  assert.ok(process.env["LANGFUSE_SECRET_KEY"]);
  process.env["LANGFUSE_HOST"] = langfuseHost();
  process.env["LANGFUSE_CAPTURE_INPUTS"] = "true";
  process.env["LANGFUSE_CAPTURE_OUTPUTS"] = "true";
  process.env["LANGFUSE_CAPTURE_TOOL_IO"] = "true";

  const started = new Date();
  const sessionId = `pi-langfuse-e2e-${crypto.randomUUID()}`;
  const handlers: HandlerMap = {};
  const pi = {
    registerCommand: () => {},
    on: (event: string, handler: (event?: unknown, ctx?: unknown) => Promise<void>) => {
      handlers[event] = handler;
    },
  };

  await lifanhPiLangfuse(pi as never);
  await handlers.before_agent_start?.(
    {
      type: "before_agent_start",
      prompt: "e2e prompt with ghp_abcdefghijklmnopqrstuvwxyz123456",
      systemPromptOptions: { cwd: process.cwd() },
    },
    {
      sessionManager: {
        getSessionFile: () => `/tmp/${sessionId}.json`,
      },
      model: { id: "e2e-model", provider: "e2e-provider" },
      getSystemPrompt: () => "system prompt",
    },
  );
  await handlers.turn_start?.({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  await handlers.before_provider_request?.({
    type: "before_provider_request",
    payload: {
      model: "e2e-model",
      messages: [{ role: "user", content: "Bearer sk-lf-should-redact" }],
      temperature: 0.1,
    },
  });
  await handlers.after_provider_response?.({
    type: "after_provider_response",
    status: 429,
    headers: {},
  });
  await handlers.after_provider_response?.({
    type: "after_provider_response",
    status: 200,
    headers: { "x-request-id": sessionId },
  });
  await handlers.tool_execution_start?.({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "shell",
    args: { command: "echo ghp_abcdefghijklmnopqrstuvwxyz123456" },
  });
  await handlers.tool_execution_end?.({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "shell",
    result: "sk-lf-should-redact",
    isError: false,
  });
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done sk-lf-should-redact" }],
    api: "e2e-api",
    provider: "e2e-provider",
    model: "e2e-model",
    responseId: sessionId,
    usage: {
      input: 11,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
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
  await handlers.agent_end?.({ type: "agent_end", messages: [assistantMessage] }, { hasUI: false });
  await handlers.session_shutdown?.({ type: "session_shutdown" }, { hasUI: false });

  const { agent, generation, tool } = await waitForObservations(sessionId, started);
  assert.equal(agent.parentObservationId, null);
  assert.equal(generation.traceId, agent.traceId);
  assert.equal(tool.traceId, agent.traceId);
  assert.equal(tool.parentObservationId, agent.id);
  assert.equal(generation.parentObservationId, agent.id);
  assert.equal(Number(generation.metadata?.["priorHttpFailures"]), 1);
  assert.equal(Number(generation.metadata?.["httpStatus"]), 200);
  for (const io of [generation.input, tool.output]) {
    assert.ok(io);
    assert.ok(io.includes("[REDACTED_SECRET]"));
    assert.ok(!io.includes("sk-lf-should-redact"));
  }
});
