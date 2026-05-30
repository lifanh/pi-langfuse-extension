import test from "node:test";
import assert from "node:assert/strict";

import {
  BasicTracerProvider,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  startObservation,
  setLangfuseTracerProvider,
} from "@langfuse/tracing";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { context, createContextKey, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { Attributes } from "@opentelemetry/api";

interface TestInfra {
  exporter: InMemorySpanExporter;
  processor: LangfuseSpanProcessor;
  provider: BasicTracerProvider;
}

function createTestInfra(): TestInfra {
  const exporter = new InMemorySpanExporter();
  const processor = new LangfuseSpanProcessor({
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    baseUrl: "http://127.0.0.1:9",
    exporter,
    shouldExportSpan: () => true,
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  return { exporter, processor, provider };
}

test("transport: agent span with child tool span creates proper hierarchy", async () => {
  const { exporter, processor, provider } = createTestInfra();

  const root = startObservation(
    "pi-agent-run",
    { metadata: { agent: "pi" } },
    { asType: "agent" },
  );
  const tool = root.startObservation(
    "tool:shell",
    { input: { cmd: "ls" } },
    { asType: "tool" },
  );
  tool.update({ output: "ok" });
  tool.end();
  root.update({ output: "done" });
  root.end();

  await processor.forceFlush();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 2, "expected 2 spans (agent + tool)");

  const toolSpan = spans.find((s) => s.name === "tool:shell");
  const agentSpan = spans.find((s) => s.name === "pi-agent-run");

  assert.ok(toolSpan, "tool span exists");
  assert.ok(agentSpan, "agent span exists");

  assert.equal(
    toolSpan.parentSpanContext?.spanId,
    agentSpan.spanContext().spanId,
    "tool is child of agent",
  );
  assert.equal(
    toolSpan.spanContext().traceId,
    agentSpan.spanContext().traceId,
    "same trace",
  );

  assert.equal(agentSpan.attributes["langfuse.observation.type"], "agent");
  assert.equal(toolSpan.attributes["langfuse.observation.type"], "tool");

  await provider.shutdown();
  setLangfuseTracerProvider(null);
});

test("transport: generation spans include model, usage, and cost attributes", async () => {
  const { exporter, processor, provider } = createTestInfra();

  const root = startObservation("run", {}, { asType: "agent" });
  const generation = root.startObservation(
    "generation:0",
    {
      input: [{ role: "user", content: "hi" }],
      model: "claude-sonnet-4",
      modelParameters: { temperature: 0.1 },
    },
    { asType: "generation" },
  );
  generation.update({
    output: "hello",
    usageDetails: { input: 10, output: 20, total: 30 },
    costDetails: { total: 0.01 },
  });
  generation.end();
  root.end();

  await processor.forceFlush();

  const span = exporter.getFinishedSpans().find((s) => s.name === "generation:0");
  assert.ok(span);
  assert.equal(span.attributes["langfuse.observation.type"], "generation");
  assert.equal(span.attributes["langfuse.observation.model.name"], "claude-sonnet-4");
  assert.equal(
    span.attributes["langfuse.observation.model.parameters"],
    JSON.stringify({ temperature: 0.1 }),
  );
  assert.equal(
    span.attributes["langfuse.observation.usage_details"],
    JSON.stringify({ input: 10, output: 20, total: 30 }),
  );
  assert.equal(
    span.attributes["langfuse.observation.cost_details"],
    JSON.stringify({ total: 0.01 }),
  );

  await provider.shutdown();
  setLangfuseTracerProvider(null);
});

test("transport: metadata attributes propagate to spans", async () => {
  const { exporter, processor, provider } = createTestInfra();

  const root = startObservation(
    "run",
    { metadata: { model: "claude" } },
    { asType: "agent" },
  );
  root.end();
  await processor.forceFlush();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  const span = spans[0];
  assert.ok(span);
  assert.equal(span.name, "run");
  assert.equal(span.attributes["langfuse.observation.metadata.model"], "claude");
  assert.equal(span.attributes["langfuse.observation.type"], "agent");

  await provider.shutdown();
  setLangfuseTracerProvider(null);
});

test("transport: error tool spans set ERROR level", async () => {
  const { exporter, processor, provider } = createTestInfra();

  const root = startObservation("run", {}, { asType: "agent" });
  const tool = root.startObservation("tool:fail", {}, { asType: "tool" });
  tool.update({
    level: "ERROR",
    statusMessage: "something broke",
    output: "error output",
  });
  tool.end();
  root.end();
  await processor.forceFlush();

  const spans = exporter.getFinishedSpans();
  const toolSpan = spans.find((s) => s.name === "tool:fail");
  assert.ok(toolSpan);
  assert.equal(toolSpan.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(
    toolSpan.attributes["langfuse.observation.status_message"],
    "something broke",
  );

  await provider.shutdown();
  setLangfuseTracerProvider(null);
});

test("transport: init sets trace attributes without global context registration", async () => {
  const {
    createAgentSpan,
    initTransport,
    setTraceAttributes,
    shutdown,
  } = await import("../src/transport.js");
  const { createCapturePolicy } = await import("../src/capture-policy.js");

  await initTransport({
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    host: "http://127.0.0.1:9",
    capturePolicy: createCapturePolicy({}),
  });

  try {
    const root = createAgentSpan("pi-agent-run", { metadata: undefined });
    assert.ok(root);

    setTraceAttributes(root, {
      traceName: "pi-agent-run",
      tags: ["pi-coding-agent"],
      sessionId: "session-123",
      metadata: {
        agent: "pi",
        count: 2,
        enabled: true,
        nested: { ignored: true },
      },
    });

    const spanAttributes = (
      root.otelSpan as unknown as { attributes: Attributes }
    ).attributes;

    assert.equal(spanAttributes["langfuse.trace.name"], "pi-agent-run");
    assert.deepEqual(spanAttributes["langfuse.trace.tags"], [
      "pi-coding-agent",
    ]);
    assert.equal(spanAttributes["session.id"], "session-123");
    assert.equal(spanAttributes["langfuse.trace.metadata.agent"], "pi");
    assert.equal(spanAttributes["langfuse.trace.metadata.count"], "2");
    assert.equal(spanAttributes["langfuse.trace.metadata.enabled"], "true");
    assert.equal(spanAttributes["langfuse.trace.metadata.nested"], undefined);
  } finally {
    await shutdown();
  }
});

test("transport: child spans inherit trace attributes from agent span", async () => {
  const {
    createAgentSpan,
    createGenerationSpan,
    createToolSpan,
    initTransport,
    setTraceAttributes,
    shutdown,
  } = await import("../src/transport.js");
  const { createCapturePolicy } = await import("../src/capture-policy.js");

  await initTransport({
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    host: "http://127.0.0.1:9",
    capturePolicy: createCapturePolicy({}),
  });

  try {
    const root = createAgentSpan("pi-agent-run", { metadata: undefined });
    assert.ok(root);

    setTraceAttributes(root, {
      traceName: "pi-agent-run",
      tags: ["pi-coding-agent"],
      sessionId: "session-123",
      metadata: { agent: "pi" },
    });

    const tool = createToolSpan(root, "tool:shell", { metadata: undefined });
    const generation = createGenerationSpan(root, "generation:0", {
      metadata: undefined,
      model: undefined,
      modelParameters: undefined,
      usageDetails: undefined,
      costDetails: undefined,
      statusMessage: undefined,
      isError: false,
    });

    assert.ok(tool);
    assert.ok(generation);

    for (const child of [tool, generation]) {
      const spanAttributes = (
        child.otelSpan as unknown as { attributes: Attributes }
      ).attributes;
      assert.equal(spanAttributes["langfuse.trace.name"], "pi-agent-run");
      assert.deepEqual(spanAttributes["langfuse.trace.tags"], [
        "pi-coding-agent",
      ]);
      assert.equal(spanAttributes["session.id"], "session-123");
      assert.equal(spanAttributes["langfuse.trace.metadata.agent"], "pi");
    }
  } finally {
    await shutdown();
  }
});

test("transport: trace attributes follow Langfuse propagated string limits", async () => {
  const {
    createAgentSpan,
    createToolSpan,
    initTransport,
    setTraceAttributes,
    shutdown,
  } = await import("../src/transport.js");
  const { createCapturePolicy } = await import("../src/capture-policy.js");

  await initTransport({
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    host: "http://127.0.0.1:9",
    capturePolicy: createCapturePolicy({}),
  });

  try {
    const root = createAgentSpan("pi-agent-run", { metadata: undefined });
    assert.ok(root);

    setTraceAttributes(root, {
      traceName: "x".repeat(201),
      tags: ["kept", "x".repeat(201)],
      sessionId: "x".repeat(201),
      metadata: { kept: "ok", dropped: "x".repeat(201) },
    });

    const tool = createToolSpan(root, "tool:shell", { metadata: undefined });
    assert.ok(tool);

    const rootAttributes = (
      root.otelSpan as unknown as { attributes: Attributes }
    ).attributes;
    const toolAttributes = (
      tool.otelSpan as unknown as { attributes: Attributes }
    ).attributes;

    for (const spanAttributes of [rootAttributes, toolAttributes]) {
      assert.equal(spanAttributes["langfuse.trace.name"], undefined);
      assert.deepEqual(spanAttributes["langfuse.trace.tags"], ["kept"]);
      assert.equal(spanAttributes["session.id"], undefined);
      assert.equal(spanAttributes["langfuse.trace.metadata.kept"], "ok");
      assert.equal(spanAttributes["langfuse.trace.metadata.dropped"], undefined);
    }
  } finally {
    await shutdown();
  }
});

test("transport: shutdown preserves pre-existing OTel context manager", async () => {
  const testKey = createContextKey("transport-pre-existing-context");
  const existingContextManager = new AsyncLocalStorageContextManager().enable();
  assert.equal(context.setGlobalContextManager(existingContextManager), true);

  const { initTransport, shutdown } = await import("../src/transport.js");
  const { createCapturePolicy } = await import("../src/capture-policy.js");

  try {
    await initTransport({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      host: "http://127.0.0.1:9",
      capturePolicy: createCapturePolicy({}),
    });
    await shutdown();

    context.with(ROOT_CONTEXT.setValue(testKey, "host-context"), () => {
      assert.equal(context.active().getValue(testKey), "host-context");
    });
  } finally {
    await shutdown();
    context.disable();
  }
});

test("transport: flush and shutdown do not throw when not initialized", async () => {
  const { flush, shutdown, isReady } = await import("../src/transport.js");
  assert.equal(isReady(), false);
  await flush();
  await shutdown();
});
