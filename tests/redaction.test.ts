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

test("redacts camelCase and snake_case secret field names", () => {
  const result = redactValue({
    apiKey: "should-be-redacted",
    access_token: "should-be-redacted",
    clientSecret: "should-be-redacted",
    AccessToken: "should-be-redacted",
    "x-api-key": "should-be-redacted",
    refresh_token: "should-be-redacted",
    sessionToken: "should-be-redacted",
    privateKey: "should-be-redacted",
    tokenCount: 42,
    maxTokens: 4096,
  }) as Record<string, unknown>;

  assert.equal(result.apiKey, "[REDACTED_SECRET]");
  assert.equal(result.access_token, "[REDACTED_SECRET]");
  assert.equal(result.clientSecret, "[REDACTED_SECRET]");
  assert.equal(result.AccessToken, "[REDACTED_SECRET]");
  assert.equal(result["x-api-key"], "[REDACTED_SECRET]");
  assert.equal(result.refresh_token, "[REDACTED_SECRET]");
  assert.equal(result.sessionToken, "[REDACTED_SECRET]");
  assert.equal(result.privateKey, "[REDACTED_SECRET]");

  // Benign keys that merely contain "token" as a substring must survive
  // untouched -- only exact normalized-name matches are redacted.
  assert.equal(result.tokenCount, 42);
  assert.equal(result.maxTokens, 4096);
});

test("redacts a secret that straddles the truncation boundary", () => {
  const maxStringLength = 60;
  const fakeKey = ["sk", "ant", "api03", "fake-test-abcdefghijklmnopqrstuvwxyz"].join("-");
  // Pad the prefix (ending on a non-word character so the token's own word
  // boundary is intact) so the secret token itself starts well before
  // maxStringLength and ends well after it -- if truncation happened before
  // redaction, the cut would land mid-token and leave a live-looking prefix
  // in the output instead of getting redacted. The padding is short enough
  // that the "[REDACTED_SECRET]" marker itself still fits before the limit.
  const padding = `${"z".repeat(39)} `;
  const value = `${padding}${fakeKey}`;

  const result = redactValue(
    { prompt: value },
    { maxStringLength },
  ) as { prompt: string };

  assert.doesNotMatch(result.prompt, /sk-ant-api03/);
  assert.match(result.prompt, /\[REDACTED_SECRET\]/);
});

test("redacts an unterminated private key block cut off by truncation", () => {
  const maxStringLength = 60;
  const body = Array.from({ length: 20 }, (_, index) => `line${index}base64data`).join("\n");
  // No "-----END ... PRIVATE KEY-----" marker at all: it either got sliced
  // off by truncation upstream, or the payload is simply malformed/partial.
  const value = `-----BEGIN RSA PRIVATE KEY-----\n${body}`;

  const result = redactValue(
    { secretBlob: value },
    { maxStringLength },
  ) as { secretBlob: string };

  assert.doesNotMatch(result.secretBlob, /base64data/);
  assert.match(result.secretBlob, /\[REDACTED_SECRET\]/);
});
