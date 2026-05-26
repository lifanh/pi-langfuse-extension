import test from "node:test";
import assert from "node:assert/strict";

import { redactValue } from "../src/redaction.js";

test("redacts common secrets recursively", () => {
  // Build a test key dynamically so the source file itself does not embed a
  // string that looks like a real provider secret to secret scanners.
  const fakeAnthropicKey = ["sk", "ant", "api03", "fake-test-abcdefghijklmnop"].join("-");
  const result = redactValue({
    prompt: `use ${fakeAnthropicKey}`,
    headers: {
      Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      Cookie: "session=secret-cookie",
    },
    nested: [
      "LANGFUSE_SECRET_KEY=sk-lf-1234567890abcdef",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ],
  }) as {
    prompt: string;
    headers: { Authorization: string; Cookie: string };
    nested: string[];
  };

  assert.equal(result.prompt, "use [REDACTED_SECRET]");
  assert.equal(result.headers.Authorization, "[REDACTED_SECRET]");
  assert.equal(result.headers.Cookie, "[REDACTED_SECRET]");
  assert.equal(result.nested[0], "LANGFUSE_SECRET_KEY=[REDACTED_SECRET]");
  assert.equal(result.nested[1], "[REDACTED_SECRET]");
});

test("hashes absolute local paths when path capture is disabled", () => {
  const result = redactValue({
    cwd: "/Users/lifan/work/private-repo",
    output: "Wrote /Users/lifan/work/private-repo/.env",
  }) as { cwd: string; output: string };

  assert.match(result.cwd, /^\[PATH_HASH:[a-f0-9]{12}\]$/);
  assert.match(result.output, /Wrote \[PATH_HASH:[a-f0-9]{12}\]\/\.env/);
  assert.doesNotMatch(result.output, /lifan|private-repo/);
});

test("limits payload shape without leaking omitted keys", () => {
  const input: Record<string, string> = {};
  for (let index = 0; index < 120; index++) {
    input[`key${index}`] = `value-${index}`;
  }

  const result = redactValue(input, { maxObjectKeys: 3 }) as Record<string, unknown>;

  assert.deepEqual(Object.keys(result), ["key0", "key1", "key2", "__truncatedKeys"]);
  assert.equal(result["__truncatedKeys"], 117);
});
