import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("uses the scoped pi-langfuse-extension npm package name", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(pkg.name, "@lifanh/pi-langfuse-extension");
});

test("does not mention external package collision history in project docs", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

  assert.doesNotMatch(readme, /unscoped package|existing package|package collision|avoid colliding/i);
});
