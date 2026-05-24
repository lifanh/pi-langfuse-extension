# @lifanh/pi-langfuse

Privacy-first Langfuse observability extension for [Pi Coding Agent](https://github.com/badlogic/pi-mono).

This package is intentionally scoped as `@lifanh/pi-langfuse` to avoid colliding with the existing unscoped `pi-langfuse` package. It starts from a stricter privacy model: metadata-only tracing by default, explicit opt-in for content capture, and one shared redaction path for every payload before it can reach Langfuse.

## Status

Early scaffold. The current implementation establishes the Pi extension entrypoint, configuration model, capture policy, redaction pipeline, and tests. Langfuse transport will be added behind these privacy controls.

Do not publish a stable `1.0.0` until trace transport, shutdown flushing, golden trace tests, and fallback behavior are implemented and verified.

## Install

After publication:

```bash
pi install npm:@lifanh/pi-langfuse
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
~/.pi/agent/@lifanh/pi-langfuse/config.json
```

The extension exposes a namespaced Pi command:

```text
/lifanh-langfuse-status
```

## Privacy Defaults

All sensitive content capture is disabled by default.

```text
LANGFUSE_CAPTURE_INPUTS=false
LANGFUSE_CAPTURE_OUTPUTS=false
LANGFUSE_CAPTURE_TOOL_IO=false
LANGFUSE_CAPTURE_SYSTEM_PROMPT=false
LANGFUSE_CAPTURE_CWD=false
```

Enable fields only when the Langfuse project is allowed to receive that data:

```bash
export LANGFUSE_CAPTURE_INPUTS=true
export LANGFUSE_CAPTURE_OUTPUTS=true
export LANGFUSE_CAPTURE_TOOL_IO=true
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

This repo exists because the current unscoped `pi-langfuse` package is useful but has gaps around privacy controls, redaction, tests, and event typing. Changes here should preserve these constraints:

- No production telemetry payload bypasses `redactValue`.
- No raw prompt, response, tool I/O, system prompt, cwd, or file path capture without an explicit capture flag.
- Langfuse failures must not break Pi agent execution.
- REST fallback remains disabled until duplicate/idempotent behavior is tested.
- Tests must cover redaction and disabled capture behavior before transport changes.

## Scripts

```bash
npm test
```

## License

MIT
