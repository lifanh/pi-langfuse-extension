import test from "node:test";
import assert from "node:assert/strict";

import { buildRunPayload } from "../src/telemetry.js";
import { createCapturePolicy } from "../src/capture-policy.js";

test("includes sessionId from event", () => {
  const config = { capturePolicy: createCapturePolicy({}) };
  const event = { sessionId: "sess-abc123" };
  const result = buildRunPayload(event, {}, config);

  assert.equal(result.sessionId, "sess-abc123");
});

test("falls back to ctx.sessionId when event has none", () => {
  const config = { capturePolicy: createCapturePolicy({}) };
  const ctx = { sessionId: "ctx-session-456" };
  const result = buildRunPayload({}, ctx, config);

  assert.equal(result.sessionId, "ctx-session-456");
});

test("falls back to ctx.session.id", () => {
  const config = { capturePolicy: createCapturePolicy({}) };
  const ctx = { session: { id: "nested-session-789" } };
  const result = buildRunPayload({}, ctx, config);

  assert.equal(result.sessionId, "nested-session-789");
});

test("sessionId is undefined when not provided", () => {
  const config = { capturePolicy: createCapturePolicy({}) };
  const result = buildRunPayload({}, {}, config);

  assert.equal(result.sessionId, undefined);
});

test("sessionId appears in metadata", () => {
  const config = { capturePolicy: createCapturePolicy({}) };
  const event = { sessionId: "sess-meta-test" };
  const result = buildRunPayload(event, {}, config);

  assert.equal(result.metadata.sessionId, "sess-meta-test");
});
