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

test("transport: flush and shutdown do not throw when not initialized", async () => {
  const { flush, shutdown, isReady } = await import("../src/transport.js");
  assert.equal(isReady(), false);
  await flush();
  await shutdown();
});
