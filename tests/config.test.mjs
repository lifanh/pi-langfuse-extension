import test from "node:test";
import assert from "node:assert/strict";

import { loadConfigFromEnv, sanitizeConfigForLog, configPathForHome } from "../src/config.js";

test("loads config from environment without enabling content capture by default", () => {
  const config = loadConfigFromEnv({
    LANGFUSE_PUBLIC_KEY: "pk-lf-public",
    LANGFUSE_SECRET_KEY: "sk-lf-secret",
    LANGFUSE_HOST: "https://cloud.langfuse.com",
  });

  assert.equal(config.publicKey, "pk-lf-public");
  assert.equal(config.secretKey, "sk-lf-secret");
  assert.equal(config.host, "https://cloud.langfuse.com");
  assert.equal(config.capturePolicy.captureInputs, false);
  assert.equal(config.capturePolicy.captureOutputs, false);
  assert.equal(config.capturePolicy.captureToolIo, false);
  assert.equal(config.capturePolicy.captureSystemPrompt, false);
  assert.equal(config.capturePolicy.captureCwd, false);
});

test("sanitizes secret values before logging", () => {
  const safe = sanitizeConfigForLog({
    publicKey: "pk-lf-public",
    secretKey: "sk-lf-secret",
    host: "https://cloud.langfuse.com",
  });

  assert.deepEqual(safe, {
    publicKey: "pk-lf...blic",
    secretKey: "[REDACTED_SECRET]",
    host: "https://cloud.langfuse.com",
  });
});

test("uses a namespaced config path", () => {
  assert.equal(
    configPathForHome("/Users/lifan"),
    "/Users/lifan/.pi/agent/@lifanh/pi-langfuse-extension/config.json",
  );
});
