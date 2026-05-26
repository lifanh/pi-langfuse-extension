import test from "node:test";
import assert from "node:assert/strict";

import { buildRunPayload, resolveSessionId } from "../src/telemetry.js";
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
