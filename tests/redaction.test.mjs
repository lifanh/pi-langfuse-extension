import test from "node:test";
import assert from "node:assert/strict";

import { redactValue } from "../src/redaction.js";

test("redacts common secrets recursively", () => {
  const result = redactValue({
    prompt: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890",
    headers: {
      Authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      Cookie: "session=secret-cookie",
    },
    nested: [
      "LANGFUSE_SECRET_KEY=sk-lf-1234567890abcdef",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ],
  });

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
  });

  assert.match(result.cwd, /^\[PATH_HASH:[a-f0-9]{12}\]$/);
  assert.match(result.output, /Wrote \[PATH_HASH:[a-f0-9]{12}\]\/\.env/);
  assert.doesNotMatch(result.output, /lifan|private-repo/);
});

test("limits payload shape without leaking omitted keys", () => {
  const input = {};
  for (let index = 0; index < 120; index++) {
    input[`key${index}`] = `value-${index}`;
  }

  const result = redactValue(input, { maxObjectKeys: 3 });

  assert.deepEqual(Object.keys(result), ["key0", "key1", "key2", "__truncatedKeys"]);
  assert.equal(result.__truncatedKeys, 117);
});
