import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
}

test("uses the scoped pi-langfuse-extension npm package name", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJson;

  assert.equal(pkg.name, "@lifanh/pi-langfuse-extension");
});

test("does not mention external package collision history in project docs", () => {
  const readme = readFileSync(
    new URL("../README.md", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    readme,
    /unscoped package|existing package|package collision|avoid colliding/i,
  );
});

test("declares OpenTelemetry peer packages needed at runtime", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJson;

  assert.ok(pkg.dependencies?.["@opentelemetry/api"]);
  assert.ok(pkg.dependencies?.["@opentelemetry/core"]);
  assert.ok(pkg.dependencies?.["@opentelemetry/exporter-trace-otlp-http"]);
});

test("keeps runtime dependencies limited to packages used by tracing transport", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJson;

  assert.equal(pkg.dependencies?.["@langfuse/client"], undefined);
  assert.equal(pkg.dependencies?.["@opentelemetry/sdk-trace-node"], undefined);
});
