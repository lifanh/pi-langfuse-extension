import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

interface PackageJson {
  name: string;
  files?: string[];
  dependencies?: Record<string, string>;
  pi?: { extensions?: string[] };
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

test("ships only built output, not TypeScript source, in the npm package", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJson;

  assert.ok(pkg.files?.includes("dist"));
  for (const entry of pkg.files ?? []) {
    assert.notEqual(entry, "src");
    assert.notEqual(entry, "index.ts");
    assert.notEqual(entry, "tsconfig.json");
  }
});

test("declares the pi extension entry point under a shipped directory", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageJson;

  const extensions = pkg.pi?.extensions ?? [];
  assert.ok(extensions.length > 0);
  for (const extensionPath of extensions) {
    assert.match(extensionPath, /^\.\/dist\//);
  }
});
