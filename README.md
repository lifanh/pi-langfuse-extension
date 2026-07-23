# @lifanh/pi-langfuse-extension

[![npm version](https://img.shields.io/npm/v/@lifanh/pi-langfuse-extension.svg)](https://www.npmjs.com/package/@lifanh/pi-langfuse-extension)
[![License](https://img.shields.io/npm/l/@lifanh/pi-langfuse-extension.svg)](LICENSE)

[Langfuse](https://langfuse.com) observability for the [Pi Coding Agent](https://github.com/badlogic/pi-mono).

When you run a Pi agent, you can't easily see what it did: which model and provider it used, how many tokens each turn burned, what it cost, which tools ran, or where a provider or tool errored. This extension sends each Pi run to Langfuse as a structured trace so you can answer those questions.

It is **private by default**: only metadata is sent. Prompts, responses, tool I/O, the system prompt, and your working directory are opt-in per field, and everything captured is redacted before it leaves your machine.

<!--
  TODO(maintainer): add a screenshot of a real `pi-agent-run` trace in the Langfuse
  UI here — the nested agent → generation → tool tree with token/cost is the single
  most useful thing a new reader can see. Suggested:
  ![Example pi-agent-run trace in Langfuse](docs/images/example-trace.png)
-->

A `pi-agent-run` trace looks like this:

```text
pi-agent-run                          (agent)      model=claude-… provider=…  session=…
├── generation:0                      (generation) 1,240 tokens   $0.004  stop=tool_use
│     └── tool:read                   (tool)       isError=false
├── generation:1                      (generation) 2,010 tokens   $0.011  stop=end_turn
│     ├── tool:bash                   (tool)       isError=false
│     └── tool:edit                   (tool)       isError=true   ← surfaced as ERROR
└── generation:2                      (generation)   890 tokens   $0.003  stop=end_turn
```

## Contents

- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [What you get](#what-you-get)
- [Privacy and content capture](#privacy-and-content-capture)
- [Configuration](#configuration)
- [Commands](#commands)
- [Verify setup](#verify-setup)
- [Disable or reset](#disable-or-reset)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Development](#development)
- [License](#license)

## Requirements

- [Pi Coding Agent](https://github.com/badlogic/pi-mono) installed.
- Node.js `>= 22`.
- A Langfuse project and its public/secret API keys ([Langfuse Cloud](https://cloud.langfuse.com) or a self-hosted instance).

## Quickstart

Install the extension:

```bash
pi install npm:@lifanh/pi-langfuse-extension
```

Configure Langfuse from inside Pi:

```text
/langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-...
/langfuse-test
/langfuse-status
```

Then start an agent run and check Langfuse for a `pi-agent-run` trace with nested generation and tool observations.

> This package is pre-1.0 and under active development. Interfaces and defaults may change between minor versions.

## What you get

Each Pi agent run creates:

- an `agent` observation for the overall run
- `generation` observations for provider/model calls
- `tool` observations for tool executions

Default (metadata-only) traces answer questions like:

- Did a Pi agent run happen?
- Which model and provider were used?
- Which turns and tools ran?
- How many tokens were used?
- What did the call cost, if Pi/provider reported cost?
- Did a provider or tool report an error?

What each observation carries by default:

| Observation | Sent by default | Not sent by default |
| --- | --- | --- |
| Agent run | `agent`, `extension`, `model`, `provider`, `sessionId` | user prompt, attachments/images/context, system prompt, cwd |
| Generation | `model`, model parameters, usage, cost, provider/API, response id, stop reason, turn index, HTTP status/headers | provider request payload and assistant response content |
| Tool | `toolName`, `toolCallId`, `isError` | tool arguments and tool results |

## Privacy and content capture

Content capture is off by default and controlled by explicit per-field flags. Anything you enable is still passed through a redaction pipeline (see [How it works](#how-it-works)) before it is sent to Langfuse.

Enable individual fields:

```text
/langfuse-configure captureInputs=true captureOutputs=true
```

| Flag | Default | When enabled |
| --- | --- | --- |
| `captureInputs` / `LANGFUSE_CAPTURE_INPUTS` | off | Captures provider request/user input content after redaction. |
| `captureOutputs` / `LANGFUSE_CAPTURE_OUTPUTS` | off | Captures assistant/provider output content after redaction. |
| `captureToolIo` / `LANGFUSE_CAPTURE_TOOL_IO` | off | Captures tool arguments and results after redaction. |
| `captureSystemPrompt` / `LANGFUSE_CAPTURE_SYSTEM_PROMPT` | off | Captures the effective system prompt after redaction. |
| `captureCwd` / `LANGFUSE_CAPTURE_CWD` | off | Captures the current working directory after path redaction/hashing. |
| `debug` / `LANGFUSE_DEBUG` | off | Enables extension debug logging. |

To return to metadata-only tracing:

```text
/langfuse-configure captureInputs=false captureOutputs=false captureToolIo=false captureSystemPrompt=false captureCwd=false
```

## Configuration

Configure from Pi:

```text
/langfuse-configure publicKey=pk-lf-... secretKey=sk-lf-... host=https://cloud.langfuse.com
```

`/langfuse-configure` preserves omitted fields when a saved config file already exists. For example, this updates only the host:

```text
/langfuse-configure host=https://us.cloud.langfuse.com
```

Configuration is saved at:

```text
~/.pi/agent/@lifanh/pi-langfuse-extension/config.json
```

You can also configure non-interactively with environment variables:

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_HOST=https://cloud.langfuse.com
```

### Which configuration wins

The source is selected as a whole, not merged field by field:

1. If both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, environment configuration is used. `LANGFUSE_HOST` or `LANGFUSE_BASE_URL` and `LANGFUSE_CAPTURE_*` flags are read from the same environment.
2. Otherwise, the saved config file is used (`~/.pi/agent/@lifanh/pi-langfuse-extension/config.json`).
3. Built-in defaults fill in missing optional values (`https://cloud.langfuse.com`, metadata-only tracing, all content capture flags off).

Environment host and capture flags are not merged into a saved config unless the environment also provides both credentials. If both environment credentials and the config file are present, environment configuration wins, and `/langfuse-status` shows this as `environment variables (overrides config file)`.

## Commands

| Command | Purpose |
| --- | --- |
| `/langfuse-status` | Show configuration source, masked public key, host, capture settings, debug setting, config path, and last transport error. |
| `/langfuse-configure ...` | Save or update credentials, host, debug, and capture flags. Omitted fields are preserved from the saved config file. |
| `/langfuse-test` | Make a timeout-bounded authenticated Langfuse API request and report success or failure in Pi. |

Commands validate arguments before changing configuration. If a command receives `captureInputs` instead of `captureInputs=true`, an unknown option such as `capturePrompts=true`, or an invalid boolean such as `captureInputs=yes`, Pi shows a warning with accepted usage and an example.

When the extension is loaded but unconfigured, Pi shows a one-time onboarding hint. During configured agent runs, the footer displays `◉ langfuse` and clears it when the run ends or the session shuts down.

## Verify setup

1. Run `/langfuse-status` to confirm the effective source, host, capture settings, and last error.
2. Run `/langfuse-test` to verify credentials and host connectivity.
3. Start an agent run and check for the `◉ langfuse` footer indicator.
4. Check Langfuse for a `pi-agent-run` trace with nested generation/tool observations.

## Disable or reset

To temporarily disable tracing, unset `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`, then remove the saved config file shown by `/langfuse-status`:

```bash
rm ~/.pi/agent/@lifanh/pi-langfuse-extension/config.json
```

To keep tracing but disable content capture:

```text
/langfuse-configure captureInputs=false captureOutputs=false captureToolIo=false captureSystemPrompt=false captureCwd=false
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/langfuse-status` says `not configured` | Run `/langfuse-configure publicKey=... secretKey=...` or set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`. |
| `/langfuse-test` returns `401` or `403` | Check that the public and secret keys belong to the same Langfuse project and host. |
| `/langfuse-test` times out | Verify network access and `LANGFUSE_HOST`; self-hosted instances must be reachable from the Pi process. |
| Status shows environment variables overriding the file | Update/unset the environment variables, or expect them to take precedence over `/langfuse-configure` values. |
| No prompt/response content appears in Langfuse | This is the default. Enable only the needed fields with `/langfuse-configure`. |
| Pi runs continue despite Langfuse errors | Expected. Langfuse failures are isolated; check `/langfuse-status` for the last captured error. |

---

The sections below are for contributors and anyone who wants to understand the internals.

## How it works

The extension maps Pi's agent lifecycle events onto Langfuse observations:

```text
Pi Agent Events
  │
  ├── session_start             ──▶  one-time onboarding hint if unconfigured
  ├── before_agent_start        ──▶  initTransport()  ──▶  createAgentSpan() ──▶ footer status
  ├── before_provider_request   ──▶  createGenerationSpan() (child of agent span)
  ├── after_provider_response   ──▶  store response metadata for generation
  ├── message_end               ──▶  cache assistant message
  ├── turn_end                  ──▶  endGenerationSpan()    (usage + output + errors)
  ├── tool_execution_start      ──▶  createToolSpan()       (child of agent span)
  ├── tool_execution_end        ──▶  endToolSpan()          (update + end)
  ├── agent_end                 ──▶  endAgentSpan()         ──▶  flush() ──▶ clear footer
  └── session_shutdown          ──▶  shutdown()             ──▶  clear footer
```

### Transport

- Uses `BasicTracerProvider` from `@opentelemetry/sdk-trace-base` with `LangfuseSpanProcessor` from `@langfuse/otel`.
- Creates Langfuse observations via `startObservation` from `@langfuse/tracing`.
- Uses Langfuse's isolated tracer provider hook instead of registering a global OpenTelemetry provider.
- Sets trace-level attributes (`langfuse.trace.name`, tags, metadata, and `session.id`) on agent spans and copies them to child generation/tool spans.
- Reinitializes transport if saved/env host or credentials change during a long-running Pi process.
- Records the last transport error for `/langfuse-status` while keeping Langfuse failures isolated from Pi agent execution.

### Redaction

Captured content passes through a shared redaction pipeline before transmission. The redactor covers:

- API keys and bearer tokens
- Authorization, cookie, token, password, and secret-like fields
- Langfuse, OpenAI, Anthropic, GitHub, npm, and AWS-style token patterns
- Private key blocks
- `.env`-style key/value secrets
- Common local absolute paths (`/Users`, `/home`, `/tmp`, `/private/tmp`, and `C:\Users`), replaced with stable short hashes
- Large or deeply nested payloads, with bounded traversal

## Development

Install dependencies and run checks:

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Changes here should preserve these constraints:

- No production telemetry payload bypasses `redactValue`.
- No raw prompt, response, tool I/O, system prompt, cwd, or file path capture without an explicit capture flag.
- Langfuse failures must not break Pi agent execution.
- REST fallback remains disabled until duplicate/idempotent behavior is tested.
- Tests must cover redaction and disabled capture behavior before transport changes.

### Release

Publishing is automated through GitHub Actions:

1. Update the package version.
2. Push the version commit and tag to GitHub.
3. Publish a GitHub Release for that tag.
4. The `Publish` workflow runs `npm ci`, typechecking, tests, build, `npm pack --dry-run`, and `npm publish`.

The workflow publishes to the official npm registry with OIDC-based npm Trusted Publishing, so no long-lived npm token is stored in GitHub.

Do not publish a stable `1.0.0` until golden trace tests, REST fallback behavior, and production burn-in are completed.

## License

MIT
