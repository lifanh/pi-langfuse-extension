# @lifanh/pi-langfuse-extension

Privacy-first Langfuse observability extension for [Pi Coding Agent](https://github.com/badlogic/pi-mono).

This package starts from a strict privacy model: metadata-only tracing by default, explicit opt-in for content capture, and one shared redaction path for every payload before it can reach Langfuse.

## 30-second quickstart

```bash
pi install npm:@lifanh/pi-langfuse-extension
```

In Pi, save credentials and keep the default minimal metadata privacy posture:

```text
/langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-...
/langfuse-test
/langfuse-status
```

To enable a specific capture flag later, you do **not** need to re-enter credentials:

```text
/langfuse-configure captureInputs=true
# or
/langfuse-privacy preset=conversations
```

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

Persist configuration from Pi with:

```text
/langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-... host=https://cloud.langfuse.com
```

`/langfuse-configure` is non-destructive. If a config file already exists, omitted fields are preserved, so changing one privacy flag is safe:

```text
/langfuse-configure captureInputs=true
/langfuse-configure host=https://us.cloud.langfuse.com
```

Optional capture flags can be saved with the same command:

```text
/langfuse-configure captureInputs=true captureOutputs=true captureToolIo=true captureSystemPrompt=true captureCwd=true debug=true
```

## Commands

| Command | Purpose |
| --- | --- |
| `/langfuse-status` | Show configuration source, masked public key, host, privacy posture, debug setting, config path, and last transport error. |
| `/langfuse-configure ...` | Save or update credentials, host, debug, and capture flags. Omitted fields are preserved from the saved config file. |
| `/langfuse-test` | Make a timeout-bounded authenticated Langfuse API request and report success or failure in Pi. |
| `/langfuse-privacy` | Show the current capture policy. |
| `/langfuse-privacy captureInputs=true` | Update one or more capture flags without re-entering credentials. |
| `/langfuse-privacy all=false` | Disable all content capture flags. |
| `/langfuse-privacy preset=minimal` | Apply a named preset: `minimal`, `strict` (alias), `prompts-only`, `conversations`, or `full-debug`. |
| `/langfuse-reset` | Delete the saved config file after confirmation. Environment variables still work. |

When the extension is loaded but unconfigured, Pi shows a one-time onboarding hint. During agent runs with tracing configured, the footer displays `◉ langfuse` and clears it when the run ends or the session shuts down.

## What gets sent by default?

By default, the extension uses **minimal metadata tracing**. This is not “no telemetry”: it creates useful Langfuse traces without prompts, responses, tool inputs/outputs, system prompts, current working directory, or raw file paths.

Default traces can still answer operational questions like:

- Did a Pi agent run happen?
- Which model/provider was used?
- Which turns and tools ran?
- How many tokens were used, and what did the call cost if Pi/provider reported cost?
- Did the provider/tool report an error?

Minimal metadata fields include:

| Observation | Metadata sent by default | Content deliberately not sent by default |
| --- | --- | --- |
| Agent run | `agent`, `extension`, `model`, `provider`, `sessionId` | user prompt, attachments/images/context, system prompt, cwd |
| Generation | `model`, model parameters, usage, cost, provider/API, response id, stop reason, turn index, HTTP status/headers | provider request payload and assistant response content |
| Tool | `toolName`, `toolCallId`, `isError` | tool arguments and tool results |

All sensitive content capture flags are disabled by default.

| Flag | Default | When enabled |
| --- | --- | --- |
| `captureInputs` / `LANGFUSE_CAPTURE_INPUTS` | off | Captures provider request/user input content after redaction. |
| `captureOutputs` / `LANGFUSE_CAPTURE_OUTPUTS` | off | Captures assistant/provider output content after redaction. |
| `captureToolIo` / `LANGFUSE_CAPTURE_TOOL_IO` | off | Captures tool arguments and results after redaction. |
| `captureSystemPrompt` / `LANGFUSE_CAPTURE_SYSTEM_PROMPT` | off | Captures the effective system prompt after redaction. |
| `captureCwd` / `LANGFUSE_CAPTURE_CWD` | off | Captures the current working directory after path redaction/hashing. |
| `debug` / `LANGFUSE_DEBUG` | off | Enables extension debug logging. |

Privacy presets map to the content capture flags:

| Preset | inputs | outputs | tool I/O | system prompt | cwd | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `minimal` | off | off | off | off | off | Default; metadata-only tracing. |
| `strict` | off | off | off | off | off | Alias for `minimal` for backwards-compatible command usage. |
| `prompts-only` | on | off | off | off | off | Captures prompts after redaction. |
| `conversations` | on | on | off | off | off | Captures prompts and responses after redaction. |
| `full-debug` | on | on | on | on | on | Captures all supported fields after redaction. |

Even when capture is enabled, payloads pass through the shared redaction pipeline.

## How to verify

1. Run `/langfuse-status` to confirm the effective source, host, privacy posture, and last error.
2. Run `/langfuse-test` to verify credentials and host connectivity.
3. Start an agent run and check for the `◉ langfuse` footer indicator.
4. Check Langfuse for a `pi-agent-run` trace with nested generation/tool observations.

## Precedence rules

Configuration precedence is:

1. Environment variables (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` or `LANGFUSE_BASE_URL`, capture flags)
2. Saved config file (`~/.pi/agent/@lifanh/pi-langfuse-extension/config.json`)
3. Built-in defaults (`https://cloud.langfuse.com`, minimal metadata tracing, all content capture flags off)

If both environment variables and the config file are present, environment variables win. `/langfuse-status` explicitly shows `environment variables (overrides config file)` in that case.

## How to disable or reset

To temporarily disable tracing, unset `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` and remove the saved config file:

```text
/langfuse-reset
```

To keep tracing but return to minimal metadata-only privacy:

```text
/langfuse-privacy all=false
# or
/langfuse-privacy preset=minimal
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/langfuse-status` says `not configured` | Run `/langfuse-configure publicKey=... secretKey=...` or set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. |
| `/langfuse-test` returns `401` or `403` | Check that the public and secret keys belong to the same Langfuse project and host. |
| `/langfuse-test` times out | Verify network access and `LANGFUSE_HOST`; self-hosted instances must be reachable from the Pi process. |
| Status shows environment variables overriding the file | Update/unset the environment variables, or expect them to take precedence over `/langfuse-configure` values. |
| No prompt/response content appears in Langfuse | This is the default privacy posture. Enable only the needed flags with `/langfuse-privacy` or `/langfuse-configure`. |
| Pi runs continue despite Langfuse errors | Expected. Langfuse failures are isolated; check `/langfuse-status` for the last captured error. |

## Architecture

```
Pi Agent Events
  │
  ├── session_start             ──▶  one-time onboarding hint if unconfigured
  ├── before_agent_start        ──▶  initTransport()  ──▶  createAgentSpan() ──▶ footer status
  ├── before_provider_request   ──▶  createGenerationSpan() (child of agent span)
  ├── after_provider_response   ──▶  update generation metadata
  ├── turn_end/message_end      ──▶  endGenerationSpan()    (usage + output + errors)
  ├── tool_execution_start      ──▶  createToolSpan()       (child of agent span)
  ├── tool_execution_end        ──▶  endToolSpan()          (update + end)
  ├── agent_end                 ──▶  endAgentSpan()         ──▶  flush() ──▶ clear footer
  └── session_shutdown          ──▶  shutdown()             ──▶  clear footer
```

**Transport layer** (`src/transport.js`):
- Uses `NodeTracerProvider` from `@opentelemetry/sdk-trace-node` with `LangfuseSpanProcessor` from `@langfuse/otel`
- Creates Langfuse observations via `startObservation` from `@langfuse/tracing`
- Uses Langfuse's isolated tracer provider hook instead of registering a global OpenTelemetry provider
- Propagates trace-level attributes (name, tags, metadata) via `propagateAttributes`
- Reinitializes transport if saved/env host or credentials change during a long-running Pi process
- Records the last transport error for `/langfuse-status` while keeping Langfuse failures isolated from Pi agent execution

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

## Release

Publishing is automated through GitHub Actions:

1. Update the package version.
2. Push the version commit and tag to GitHub.
3. Publish a GitHub Release for that tag.
4. The `Publish` workflow runs `npm ci`, typechecking, tests, build, `npm pack --dry-run`, and `npm publish`.

The workflow publishes to the official npm registry with OIDC-based npm Trusted Publishing, so no long-lived npm token is stored in GitHub.

## License

MIT
