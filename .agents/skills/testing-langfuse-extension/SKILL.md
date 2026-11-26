---
name: testing-langfuse-extension
description: Test the pi-langfuse-extension end-to-end against a real Langfuse instance. Use when verifying trace transport, privacy controls, redaction, or error isolation.
---

## Overview

This extension has no UI. Testing is shell-only — simulate Pi lifecycle events via a mock `pi` object and verify traces in the Langfuse REST API.

## Devin Secrets Needed

- `LANGFUSE_PUBLIC_KEY` — Langfuse project public key (pk-lf-...)
- `LANGFUSE_SECRET_KEY` — Langfuse project secret key (sk-lf-...)
- `LANGFUSE_BASE_URL` — Langfuse host URL (e.g. https://us.cloud.langfuse.com)

## Running Unit Tests

```bash
npm test
```

Runs all tests in `tests/*.test.mjs` using Node's built-in test runner. Expects 14+ tests to pass.

## E2E Testing Pattern

The extension exports a default async function that takes a `pi` object. Create a mock:

```js
const handlers = {};
const pi = {
  registerCommand: () => {},
  on: (event, handler) => { handlers[event] = handler; },
};
await lifanhPiLangfuse(pi);
```

Then fire events in order:
1. `handlers.before_agent_start(event, ctx)` — creates agent span
2. `handlers.tool_execution_start(event)` — creates tool span
3. `handlers.tool_execution_end(event)` — ends tool span
4. `handlers.agent_end(event)` — ends agent span + flushes
5. `handlers.session_shutdown()` — full shutdown

**Important:** Set `LANGFUSE_HOST` env var (not just `LANGFUSE_BASE_URL`) when running the extension, as `loadConfig()` reads from `LANGFUSE_HOST`. You may need: `LANGFUSE_HOST=$LANGFUSE_BASE_URL`.

## Verifying Traces in Langfuse

With credentials for a disposable Langfuse Cloud test project, run the synthetic lifecycle and read back its observations:

```bash
RUN_LANGFUSE_E2E=true npx tsx --test tests/e2e-langfuse.test.ts
```

The test polls `/api/public/v2/observations` for its unique session until the agent, generation, and tool have arrived, then checks their hierarchy and redacted I/O. A successful `/langfuse-test` checks credentials, not delivery.

## Key Test Scenarios

1. **Trace hierarchy**: Verify agent observation (type=AGENT) has no parent, tool observation (type=TOOL) has parentObservationId matching agent's id
2. **Default privacy**: With no LANGFUSE_CAPTURE_* flags, input/output should be null on all observations; metadata should be present
3. **Capture + redaction**: With LANGFUSE_CAPTURE_INPUTS/OUTPUTS/TOOL_IO=true, verify content appears but secrets (sk-ant-*, sk-lf-*, ghp_*, Bearer tokens) are replaced with [REDACTED_SECRET]
4. **Error isolation**: Set LANGFUSE_HOST to unreachable address, verify full lifecycle completes with exit code 0

## Gotchas

- Each test script must run in a **fresh Node process**. The NodeTracerProvider registers globally; running multiple tests in one process causes the second test's provider to conflict with the shut-down first one.
- The `propagateAttributes` warning about non-string metadata values is benign (SDK limitation for non-string attribute values).
- The Langfuse skill (`npx @langfuse/cli`) can also be used to query traces if preferred over raw curl.
