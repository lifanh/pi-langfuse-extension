# @lifanh/pi-langfuse-extension

Privacy-first Langfuse observability extension for [Pi Coding Agent](https://github.com/badlogic/pi-mono).

This package starts from a strict privacy model: metadata-only tracing by default, explicit opt-in for content capture, and one shared redaction path for every payload before it can reach Langfuse.

## Status

Active pre-1.0 development. Version `0.1.0` is published on npm as `@lifanh/pi-langfuse-extension`, and future releases are published from GitHub Releases through the `Publish` GitHub Actions workflow using npm Trusted Publishing.

The extension sends traces to Langfuse via the OpenTelemetry-based Langfuse SDK v5. Each Pi agent run creates a parent `agent` observation with nested `generation` observations for provider/model calls and nested `tool` observations for every tool execution. All payloads pass through the privacy controls (capture policy + redaction) before transmission.

Do not publish a stable `1.0.0` until golden trace tests, REST fallback behavior, and production burn-in are completed.

## Install

```bash
pi install npm:@lifanh/pi-langfuse-extension
```

For local development:

```bash
npm install
npm test
```

## Release

Publishing is automated through GitHub Actions:

1. Update the package version.
2. Push the version commit and tag to GitHub.
3. Publish a GitHub Release for that tag.
4. The `Publish` workflow runs `npm ci`, typechecking, tests, build, `npm pack --dry-run`, and `npm publish`.

The workflow publishes to the official npm registry with OIDC-based npm Trusted Publishing, so no long-lived npm token is stored in GitHub.

## Configuration

Set Langfuse credentials through environment variables for non-interactive use:

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_HOST=https://cloud.langfuse.com
```

Configuration files are namespaced under:

```text
~/.pi/agent/@lifanh/pi-langfuse-extension/config.json
```

The extension exposes a namespaced Pi command:

```text
/lifanh-langfuse-status
```

Persist configuration from Pi with:

```text
/lifanh-langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-... host=https://cloud.langfuse.com
```

Optional capture flags can be saved with the same command:

```text
/lifanh-langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-... captureInputs=true captureOutputs=true captureToolIo=true captureSystemPrompt=true debug=true
```

## Architecture

```
Pi Agent Events
  │
  ├── before_agent_start       ──▶  initTransport()  ──▶  createAgentSpan()
  ├── before_provider_request  ──▶  createGenerationSpan() (child of agent span)
  ├── after_provider_response  ──▶  update generation metadata
  ├── turn_end/message_end     ──▶  endGenerationSpan()    (usage + output + errors)
  ├── tool_execution_start     ──▶  createToolSpan()       (child of agent span)
  ├── tool_execution_end       ──▶  endToolSpan()          (update + end)
  ├── agent_end                ──▶  endAgentSpan()         ──▶  flush()
  └── session_shutdown         ──▶  shutdown()
```

**Transport layer** (`src/transport.js`):
- Uses `NodeTracerProvider` from `@opentelemetry/sdk-trace-node` with `LangfuseSpanProcessor` from `@langfuse/otel`
- Creates Langfuse observations via `startObservation` from `@langfuse/tracing`
- Uses Langfuse's isolated tracer provider hook instead of registering a global OpenTelemetry provider
- Propagates trace-level attributes (name, tags, metadata) via `propagateAttributes`
- Reinitializes transport if saved/env host or credentials change during a long-running Pi process
- All errors are caught and logged — Langfuse failures never break the Pi agent

## Privacy Defaults

All sensitive content capture is disabled by default.

```text
LANGFUSE_CAPTURE_INPUTS=false
LANGFUSE_CAPTURE_OUTPUTS=false
LANGFUSE_CAPTURE_TOOL_IO=false
LANGFUSE_CAPTURE_SYSTEM_PROMPT=false
LANGFUSE_CAPTURE_CWD=false
LANGFUSE_DEBUG=false
```

Enable fields only when the Langfuse project is allowed to receive that data:

```bash
export LANGFUSE_CAPTURE_INPUTS=true
export LANGFUSE_CAPTURE_OUTPUTS=true
export LANGFUSE_CAPTURE_TOOL_IO=true
export LANGFUSE_CAPTURE_SYSTEM_PROMPT=true
```

Even when capture is enabled, payloads pass through the shared redaction pipeline.

## Redaction

The redactor covers:

- API keys and bearer tokens
- Authorization, cookie, token, password, and secret-like fields
- Langfuse, OpenAI, Anthropic, GitHub, npm, and AWS-style token patterns
- Private key blocks
- `.env`-style key/value secrets
- Local absolute paths, replaced with stable short hashes
- Large or deeply nested payloads, with bounded traversal

## Development Guardrails

Changes here should preserve these constraints:

- No production telemetry payload bypasses `redactValue`.
- No raw prompt, response, tool I/O, system prompt, cwd, or file path capture without an explicit capture flag.
- Langfuse failures must not break Pi agent execution.
- REST fallback remains disabled until duplicate/idempotent behavior is tested.
- Tests must cover redaction and disabled capture behavior before transport changes.

## Scripts

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## License

MIT
