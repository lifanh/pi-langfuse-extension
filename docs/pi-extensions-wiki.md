# Pi Coding Agent — Extensions Wiki

> **Source:** [pi.dev/docs/latest/extensions](https://pi.dev/docs/latest/extensions)  
> **Tip:** Pi can create extensions for you. Just describe your use case in a prompt.

---

## Table of Contents

1. [What Are Extensions?](#what-are-extensions)
2. [Quick Start](#quick-start)
3. [Extension Locations](#extension-locations)
4. [File Structure Styles](#file-structure-styles)
5. [Available Imports](#available-imports)
6. [Writing an Extension](#writing-an-extension)
7. [Event System](#event-system)
   - [Lifecycle Overview](#lifecycle-overview)
   - [Resource Events](#resource-events)
   - [Session Events](#session-events)
   - [Agent Events](#agent-events)
   - [Model Events](#model-events)
   - [Tool Events](#tool-events)
   - [Input Events](#input-events)
8. [ExtensionContext Reference](#extensioncontext-reference)
9. [ExtensionCommandContext Reference](#extensioncommandcontext-reference)
10. [ExtensionAPI Methods](#extensionapi-methods)
11. [State Management](#state-management)
12. [Custom Tools](#custom-tools)
13. [Custom UI](#custom-ui)
14. [TUI Components](#tui-components)
15. [Error Handling](#error-handling)
16. [Mode Behavior](#mode-behavior)
17. [Packaging & Distribution](#packaging--distribution)
18. [Examples Reference](#examples-reference)

---

## What Are Extensions?

Extensions are **TypeScript modules** that extend Pi's behavior. They are loaded at startup (or hot-reloaded with `/reload`) and can:

| Capability | API |
|---|---|
| Register custom LLM-callable tools | `pi.registerTool()` |
| Intercept & block tool calls | `pi.on("tool_call", ...)` |
| Inject context / modify system prompts | `pi.on("before_agent_start", ...)` |
| Prompt users interactively | `ctx.ui.confirm()`, `ctx.ui.select()`, etc. |
| Build full custom TUI components | `ctx.ui.custom()` |
| Register slash commands | `pi.registerCommand()` |
| Persist state across restarts | `pi.appendEntry()` |
| Control how tools render in the UI | `renderCall` / `renderResult` |

### Common Use Cases

- **Permission gates** – Confirm before `rm -rf`, `sudo`, or other destructive commands
- **Git checkpointing** – Stash at each turn, restore on branch
- **Path protection** – Block writes to `.env`, `node_modules/`, secrets
- **Custom compaction** – Summarize conversations your way
- **Conversation summaries** – Show a `/summarize` command
- **Interactive tools** – Questions, wizards, custom dialogs
- **Stateful tools** – Todo lists, connection pools
- **External integrations** – File watchers, webhooks, CI triggers
- **Games** – Snake, etc. (see `snake.ts` example)

---

## Quick Start

Create `~/.pi/agent/extensions/my-extension.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // React to events
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register a custom tool
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register a slash command
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

**Test without installing** using the `-e` / `--extension` flag:

```bash
pi -e ./my-extension.ts
```

**Hot-reload** after editing (when in an auto-discovered location):

```
/reload
```

---

## Extension Locations

> ⚠️ **Security:** Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.

Pi auto-discovers extensions from these paths:

| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | Global (all projects) |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/*/index.ts` | Project-local (subdirectory) |

**Additional paths** via `settings.json`:

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensions": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

**Placement matters for `/reload`:** Extensions in auto-discovered locations support hot-reload. The `-e ./path.ts` flag is for quick tests only — those cannot be hot-reloaded.

---

## File Structure Styles

### Single File (simplest)

```
~/.pi/agent/extensions/
└── my-extension.ts
```

### Directory with `index.ts` (multi-file)

```
~/.pi/agent/extensions/
└── my-extension/
    ├── index.ts        # Entry point (exports default function)
    ├── tools.ts        # Helper module
    └── utils.ts
```

### Package with npm dependencies

```
~/.pi/agent/extensions/
└── my-extension/
    ├── package.json    # Declares deps and entry points
    ├── package-lock.json
    ├── node_modules/
    └── src/
        └── index.ts
```

```json
// package.json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0",
    "chalk": "^5.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Run `npm install` in the directory; imports from `node_modules/` then work automatically.

---

## Available Imports

| Package | Purpose |
|---|---|
| `@earendil-works/pi-coding-agent` | Extension types (`ExtensionAPI`, `ExtensionContext`, events) |
| `typebox` | Schema definitions for tool parameters |
| `@earendil-works/pi-ai` | AI utilities (`StringEnum` for Google-compatible enums) |
| `@earendil-works/pi-tui` | TUI components for custom rendering |

**Node.js built-ins** (`node:fs`, `node:path`, etc.) are also available.

**npm packages** — Add a `package.json` next to your extension, run `npm install`, and imports from `node_modules/` are resolved automatically.

> Extensions are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works **without compilation**.

---

## Writing an Extension

An extension exports a **default factory function** that receives `ExtensionAPI`. It can be sync or async:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("event_name", async (event, ctx) => {
    const ok = await ctx.ui.confirm("Title", "Are you sure?");
    ctx.ui.notify("Done!", "info");
    ctx.ui.setStatus("my-ext", "Processing...");  // Footer status
    ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"]);  // Widget above editor
  });

  pi.registerTool({ ... });
  pi.registerCommand("name", { ... });
  pi.registerShortcut("ctrl+x", { ... });
  pi.registerFlag("my-flag", { ... });
}
```

### Async Factory Functions

Use an `async` factory for one-time startup work (e.g., fetching config, discovering models):

```typescript
export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = await response.json();

  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

> If the factory returns a `Promise`, Pi awaits it before continuing startup. Async initialization completes **before** `session_start`, `resources_discover`, and provider registrations.

---

## Event System

### Lifecycle Overview

```
pi starts
  │
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }

user sends prompt
  ├─► input (intercept, transform, or handle)
  ├─► before_agent_start (inject message, modify system prompt)
  ├─► agent_start
  ├─► message_start / message_update / message_end
  │
  │   ┌─── turn (repeats while LLM calls tools) ───┐
  │   ├─► turn_start
  │   ├─► context (modify messages)
  │   ├─► before_provider_request
  │   ├─► after_provider_response
  │   │   LLM responds, tool calls:
  │   │     ├─► tool_execution_start
  │   │     ├─► tool_call  ← can BLOCK
  │   │     ├─► tool_execution_update
  │   │     ├─► tool_result  ← can MODIFY
  │   │     └─► tool_execution_end
  │   └─► turn_end
  │
  └─► agent_end

/new or /resume
  ├─► session_before_switch (can cancel)
  ├─► session_shutdown
  ├─► session_start { reason: "new" | "resume" }
  └─► resources_discover

/fork or /clone
  ├─► session_before_fork (can cancel)
  ├─► session_shutdown
  └─► session_start { reason: "fork" }

/compact
  ├─► session_before_compact (can cancel or customize)
  └─► session_compact

exit
  └─► session_shutdown
```

---

### Resource Events

#### `resources_discover`

Fired after `session_start`. Return additional paths for skills, prompts, and themes.

```typescript
pi.on("resources_discover", async (event, _ctx) => {
  // event.cwd, event.reason ("startup" | "reload")
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

---

### Session Events

#### `session_start`

Fired when a session is started, loaded, or reloaded.

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason: "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile: present for "new", "resume", "fork"
  ctx.ui.notify(`Session started: ${event.reason}`, "info");
});
```

#### `session_before_switch`

Fired before `/new` or `/resume`. Return `{ cancel: true }` to block it.

```typescript
pi.on("session_before_switch", async (event, ctx) => {
  // event.reason: "new" | "resume"
  // event.targetSessionFile (only for "resume")
  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("Clear?", "Delete all messages?");
    if (!ok) return { cancel: true };
  }
});
```

#### `session_before_fork`

Fired before `/fork` or `/clone`.

```typescript
pi.on("session_before_fork", async (event, ctx) => {
  // event.entryId, event.position ("before" | "at")
  return { cancel: true }; // or allow
});
```

#### `session_before_compact` / `session_compact`

Fired on compaction. Allows cancellation or custom summary.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, signal } = event;

  // Cancel:
  return { cancel: true };

  // Provide custom summary:
  return {
    compaction: {
      summary: "Custom summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});

pi.on("session_compact", async (event, ctx) => {
  // event.compactionEntry, event.fromExtension
});
```

#### `session_shutdown`

Fired before an extension runtime is torn down. Use for cleanup.

```typescript
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason: "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionFile (for session replacement flows)
});
```

---

### Agent Events

#### `before_agent_start`

Fired after user submits prompt, before the agent loop. **Can inject messages and modify system prompts.**

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt, event.images, event.systemPrompt, event.systemPromptOptions
  return {
    // Inject a persistent message into the session
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // Modify system prompt for this turn (chained across extensions)
    systemPrompt: event.systemPrompt + "\n\nExtra instructions...",
  };
});
```

> `event.systemPromptOptions` gives access to the structured data Pi uses to build the system prompt — custom prompts, guidelines, tool snippets, context files, skills.

#### `agent_start` / `agent_end`

Fired once per user prompt.

```typescript
pi.on("agent_start", async (_event, ctx) => {});

pi.on("agent_end", async (event, ctx) => {
  // event.messages — messages from this prompt
});
```

#### `turn_start` / `turn_end`

Fired for each LLM turn (one response + tool calls).

```typescript
pi.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

pi.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### `message_start` / `message_update` / `message_end`

Fired for message lifecycle. `message_end` handlers can return `{ message }` to replace the finalized message (same role required).

```typescript
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;
  return {
    message: {
      ...event.message,
      usage: { ...event.message.usage, cost: { total: 0.123 } },
    },
  };
});
```

#### `context`

Fired before each LLM call. Modify messages non-destructively.

```typescript
pi.on("context", async (event, ctx) => {
  // event.messages is a deep copy — safe to modify
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### `before_provider_request`

Fired after the provider payload is built, before the HTTP request.

```typescript
pi.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));
  // Optional: return modified payload
  // return { ...event.payload, temperature: 0 };
});
```

#### `after_provider_response`

Fired after HTTP response received, before stream body is consumed.

```typescript
pi.on("after_provider_response", (event, ctx) => {
  // event.status, event.headers
  if (event.status === 429) {
    console.log("Rate limited, retry-after:", event.headers["retry-after"]);
  }
});
```

---

### Model Events

#### `model_select`

Fired when the model changes.

```typescript
pi.on("model_select", async (event, ctx) => {
  // event.model, event.previousModel, event.source ("set" | "cycle" | "restore")
  ctx.ui.setStatus("model", `${event.model.provider}/${event.model.id}`);
});
```

#### `thinking_level_select`

Fired when thinking level changes. Notification-only (return values ignored).

```typescript
pi.on("thinking_level_select", async (event, ctx) => {
  // event.level, event.previousLevel
  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

---

### Tool Events

#### `tool_call`

Fired before a tool executes. **Can block.** `event.input` is **mutable** — mutate in-place to patch tool arguments.

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    // event.input is typed as { command: string; timeout?: number }

    // Prepend profile loading
    event.input.command = `source ~/.profile\n${event.input.command}`;

    // Block dangerous commands
    if (event.input.command.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  }
});
```

**Typing custom tool input:**

```typescript
export type MyToolInput = Static<typeof myToolSchema>;

// In another extension:
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { MyToolInput } from "my-extension";

pi.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action; // typed!
  }
});
```

#### `tool_result`

Fired after tool execution. **Can modify the result.** Handlers chain as middleware.

```typescript
import { isBashToolResult } from "@earendil-works/pi-coding-agent";

pi.on("tool_result", async (event, ctx) => {
  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,  // respects abort / Esc
  });

  return {
    content: [{ type: "text", text: await response.text() }],
    isError: false,
  };
});
```

#### `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

Observation-only events for tool execution lifecycle.

```typescript
pi.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

pi.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

pi.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

---

### Input Events

#### `user_bash`

Fired when the user executes `!` or `!!` commands. Can intercept and provide custom bash operations.

```typescript
pi.on("user_bash", (event, ctx) => {
  // event.command, event.excludeFromContext, event.cwd
  return {
    operations: remoteBashOps,   // Option 1: custom operations (e.g., SSH)
    // OR
    result: { output: "...", exitCode: 0, cancelled: false, truncated: false }, // Option 2: direct result
  };
});
```

#### `input`

Fired when user input is received, before skill/template expansion.

```typescript
pi.on("input", async (event, ctx) => {
  // event.text, event.images, event.source ("interactive" | "rpc" | "extension")

  // Transform: rewrite input
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // Handle: respond without LLM
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  return { action: "continue" }; // pass through (default)
});
```

**Return values:**
- `continue` — pass through unchanged
- `transform` — modify text/images, then continue
- `handled` — skip agent entirely

---

## ExtensionContext Reference

All event handlers receive `ctx: ExtensionContext`.

| Property / Method | Description |
|---|---|
| `ctx.ui` | UI interaction methods (see [Custom UI](#custom-ui)) |
| `ctx.hasUI` | `false` in print (`-p`) and JSON mode |
| `ctx.cwd` | Current working directory |
| `ctx.sessionManager` | Read-only session state (entries, branch, leaf ID) |
| `ctx.modelRegistry` / `ctx.model` | Access to models and API keys |
| `ctx.signal` | Abort signal for the current agent turn |
| `ctx.isIdle()` | Whether the agent is idle |
| `ctx.abort()` | Abort the current agent turn |
| `ctx.hasPendingMessages()` | Whether messages are queued |
| `ctx.shutdown()` | Request graceful pi shutdown |
| `ctx.getContextUsage()` | Current context token usage |
| `ctx.compact(options?)` | Trigger compaction without awaiting |
| `ctx.getSystemPrompt()` | Current system prompt string |

### `ctx.signal`

Use for abort-aware nested async work:

```typescript
pi.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,  // Esc will cancel this fetch
  });
});
```

> `ctx.signal` is typically defined during active turn events (`tool_call`, `tool_result`, etc.) and `undefined` in idle contexts.

### `ctx.compact()`

```typescript
ctx.compact({
  customInstructions: "Focus on recent changes",
  onComplete: (result) => ctx.ui.notify("Compacted!", "info"),
  onError: (error) => ctx.ui.notify(`Failed: ${error.message}`, "error"),
});
```

---

## ExtensionCommandContext Reference

Command handlers receive `ExtensionCommandContext`, which extends `ExtensionContext` with session control. These methods are **only available in commands** (calling from event handlers can deadlock).

### `ctx.waitForIdle()`

Wait for the agent to finish streaming before modifying the session.

```typescript
pi.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // Safe to modify session now
  },
});
```

### `ctx.newSession(options?)`

Create a new session.

```typescript
await ctx.newSession({
  parentSession: ctx.sessionManager.getSessionFile(),
  setup: async (sm) => {
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "Context..." }], timestamp: Date.now() });
  },
  withSession: async (ctx) => {
    await ctx.sendUserMessage("Continue here!");
  },
});
```

### `ctx.fork(entryId, options?)`

Fork from a specific entry.

```typescript
await ctx.fork("entry-id-123", {
  position: "before",  // "before" (default) or "at" for clone
  withSession: async (ctx) => {
    ctx.ui.notify("Forked!", "info");
  },
});
```

### `ctx.navigateTree(targetId, options?)`

Navigate to a different point in the session tree.

```typescript
await ctx.navigateTree("entry-id-456", {
  summarize: true,
  customInstructions: "Focus on error handling",
  label: "review-checkpoint",
});
```

### `ctx.switchSession(sessionPath, options?)`

Switch to a different session file.

```typescript
// List available sessions
import { SessionManager } from "@earendil-works/pi-coding-agent";
const sessions = await SessionManager.list(ctx.cwd);

// Switch to one
await ctx.switchSession(sessions[0].file, {
  withSession: async (ctx) => ctx.ui.notify("Switched!", "info"),
});
```

### `ctx.reload()`

Run the same reload flow as `/reload`. Treat as terminal for the handler.

```typescript
pi.registerCommand("reload-runtime", {
  handler: async (_args, ctx) => {
    await ctx.reload();
    return; // Always return immediately after reload
  },
});
```

> **Footgun:** After `ctx.reload()`, code in the handler still runs from the pre-reload version. Old `pi` / `ctx` objects become stale after `withSession` runs — always use the fresh `ctx` passed to `withSession`.

---

## ExtensionAPI Methods

### `pi.on(event, handler)`

Subscribe to lifecycle events. See [Event System](#event-system).

### `pi.registerTool(definition)`

Register a custom tool callable by the LLM. Works during and after startup — new tools are immediately available without `/reload`.

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  promptSnippet: "Summarize or transform text according to action",
  promptGuidelines: ["Use my_tool when the user asks to summarize previously generated text."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // Optional shim — runs before schema validation
    return args;
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return {
      content: [{ type: "text", text: "Done" }],
      details: { result: "..." },
    };
  },
  renderCall(args, theme, context) { /* optional */ },
  renderResult(result, options, theme, context) { /* optional */ },
});
```

> **Important:** `promptGuidelines` bullets are appended to the `Guidelines` section with no tool name prefix. Always name the tool explicitly: write `"Use my_tool when..."` not `"Use this tool when..."`.

### `pi.sendMessage(message, options?)`

Inject a custom message into the session.

```typescript
pi.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
}, {
  deliverAs: "steer",     // "steer" | "followUp" | "nextTurn"
  triggerTurn: true,
});
```

**Delivery modes:**
- `"steer"` (default) — queued during streaming; delivered after current tool calls finish
- `"followUp"` — waits for agent to fully finish
- `"nextTurn"` — queued for next user prompt; doesn't interrupt

### `pi.sendUserMessage(content, options?)`

Send an actual user message (as if typed). Always triggers a turn.

```typescript
pi.sendUserMessage("What is 2+2?");
// Or with images
pi.sendUserMessage([{ type: "text", text: "Describe:" }, { type: "image", ... }]);
// During streaming
pi.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
```

### `pi.appendEntry(customType, data?)`

Persist extension state to the session file (does **NOT** participate in LLM context).

```typescript
pi.appendEntry("my-state", { count: 42 });

// Restore on reload:
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // Restore from entry.data
    }
  }
});
```

### `pi.setSessionName(name)` / `pi.getSessionName()`

Set or get the session display name (shown in session selector).

```typescript
pi.setSessionName("Refactor auth module");
const name = pi.getSessionName();
```

### `pi.setLabel(entryId, label)`

Set or clear a bookmark label on an entry (shown in `/tree` selector).

```typescript
pi.setLabel(entryId, "checkpoint-before-refactor");
pi.setLabel(entryId, undefined); // clear
```

### `pi.registerCommand(name, options)`

Register a `/command` that users can type.

```typescript
pi.registerCommand("summarize", {
  description: "Summarize the conversation",
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    ctx.ui.notify("Summarizing...", "info");
    // ...
  },
});
```

### `pi.registerShortcut(shortcut, options)`

Register a keyboard shortcut.

```typescript
pi.registerShortcut("ctrl+shift+s", {
  description: "Save checkpoint",
  handler: async (ctx) => {
    pi.setLabel(ctx.sessionManager.getLeafId(), "checkpoint");
    ctx.ui.notify("Checkpoint saved!", "info");
  },
});
```

### `pi.registerFlag(name, options)`

Register a runtime flag toggle.

### `pi.exec(command, args, options?)`

Execute a shell command from an extension.

### `pi.getActiveTools()` / `pi.getAllTools()` / `pi.setActiveTools(names)`

Manage which tools are active in the current session.

```typescript
const all = pi.getAllTools();
pi.setActiveTools(all.map(t => t.name).filter(n => n !== "bash"));
```

### `pi.setModel(model)`

Programmatically switch the active model.

### `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`

Get or set the thinking level.

### `pi.registerProvider(name, config)` / `pi.unregisterProvider(name)`

Register a custom LLM provider (see async factory example above).

### `pi.registerMessageRenderer(customType, renderer)`

Register a renderer for custom message types (from `pi.appendEntry` or `pi.sendMessage`).

---

## State Management

Extensions can persist state to survive hot-reloads and restarts using `pi.appendEntry()`:

```typescript
// Save state
pi.appendEntry("todo-items", { items: todoList });

// Restore on session_start
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "todo-items") {
      todoList = entry.data.items;
    }
  }
});
```

State entries are stored in the session `.jsonl` file but are **not** sent to the LLM.

---

## Custom Tools

### Tool Definition

```typescript
pi.registerTool({
  name: "my_tool",          // snake_case, unique
  label: "My Tool",          // display name in TUI
  description: "...",        // shown to LLM
  parameters: Type.Object({
    // Typebox schema
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Stream progress updates
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });

    return {
      content: [{ type: "text", text: "Result" }],
      details: { structured: "data" },
    };
  },
});
```

### Overriding Built-in Tools

Register with the same name as a built-in to override it:

```typescript
pi.registerTool({
  name: "read",  // overrides the built-in read tool
  // ...
});
```

### Terminating Tools (Structured Output)

Use `terminate: true` to signal the agent to stop after calling the tool:

```typescript
pi.registerTool({
  name: "finish",
  description: "Return final structured result",
  parameters: Type.Object({
    result: Type.String(),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return {
      content: [{ type: "text", text: params.result }],
      terminate: true,
    };
  },
});
```

### Remote Execution (SSH)

Use `user_bash` event or `pi.exec()` to route tool execution to a remote host. See [ssh.ts example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/ssh.ts).

### Output Truncation

```typescript
import { truncateHead } from "@earendil-works/pi-coding-agent";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await getLargeOutput();
  return {
    content: [{ type: "text", text: truncateHead(output, 10000) }],
  };
}
```

### Custom Tool Rendering

```typescript
pi.registerTool({
  name: "my_tool",
  // ...
  renderCall(args, theme, context) {
    // Return a TUI Component or string[]
    return new Text(theme.fg("accent", `Running: ${args.action}`), 1, 0);
  },
  renderResult(result, options, theme, context) {
    return new Markdown(result.details.markdown, 0, 0, getMarkdownTheme());
  },
});
```

---

## Custom UI

All UI interaction goes through `ctx.ui`.

### Simple Interactions

```typescript
// Notification
ctx.ui.notify("Message", "info"); // levels: "info" | "success" | "error" | "warning"

// Confirmation dialog
const ok = await ctx.ui.confirm("Title", "Are you sure?");

// Single selection
const choice = await ctx.ui.select("Pick one:", ["Option A", "Option B", "Option C"]);

// Text input
const text = await ctx.ui.input("Enter a value:", { placeholder: "...", defaultValue: "foo" });

// Full-screen editor
const code = await ctx.ui.editor("Edit the content:", initialContent, { language: "typescript" });

// Set editor text (programmatic)
ctx.ui.setEditorText("New content");
```

### Footer Status

```typescript
// Show status in footer
ctx.ui.setStatus("my-ext", theme.fg("accent", "● active"));

// Clear status
ctx.ui.setStatus("my-ext", undefined);
```

### Widgets Above/Below Editor

```typescript
// Simple string array widget (above editor by default)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);

// Below the editor
ctx.ui.setWidget("my-widget", ["Line 1"], { placement: "belowEditor" });

// Dynamic widget with theme
ctx.ui.setWidget("my-widget", (_tui, theme) => ({
  render: () => items.map(i => theme.fg(i.done ? "success" : "muted", i.label)),
  invalidate: () => {},
}));

// Clear
ctx.ui.setWidget("my-widget", undefined);
```

### Custom Working Indicator

```typescript
// Animated indicator
ctx.ui.setWorkingIndicator({
  frames: ["·", "•", "●", "•"],
  intervalMs: 120,
});

// Hide
ctx.ui.setWorkingIndicator({ frames: [] });

// Restore default
ctx.ui.setWorkingIndicator();
```

### Custom Footer

```typescript
ctx.ui.setFooter((tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    // footerData.getGitBranch(): string | null
    // footerData.getExtensionStatuses(): ReadonlyMap<string, string>
    return [`${ctx.model?.id} (${footerData.getGitBranch() || "no git"})`];
  },
  dispose: footerData.onBranchChange(() => tui.requestRender()),
}));

ctx.ui.setFooter(undefined); // restore default
```

### Dialogs

```typescript
// Timed dialog with countdown
const result = await ctx.ui.confirm("Timeout!", "Proceed?", { timeoutMs: 5000, defaultValue: true });

// With AbortSignal (dismiss programmatically)
const controller = new AbortController();
const result = await ctx.ui.confirm("Title", "Confirm?", { signal: controller.signal });
controller.abort(); // dismiss from elsewhere
```

### Full Custom TUI Components

For complex interactive UI, use `ctx.ui.custom()`:

```typescript
const result = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
  const myComponent = buildComponent({ onSelect: done, onCancel: () => done(null) });
  return {
    render: (w) => myComponent.render(w),
    invalidate: () => myComponent.invalidate(),
    handleInput: (data) => { myComponent.handleInput(data); tui.requestRender(); },
  };
});
```

**As an overlay** (renders on top without clearing screen):

```typescript
const result = await ctx.ui.custom<string | null>(
  (tui, theme, keybindings, done) => new MyDialog({ onClose: done }),
  {
    overlay: true,
    overlayOptions: {
      width: "50%",
      anchor: "right-center",
      margin: 2,
    },
  }
);
```

---

## TUI Components

Import from `@earendil-works/pi-tui`:

```typescript
import { Text, Box, Container, Spacer, Markdown, SelectList, SettingsList } from "@earendil-works/pi-tui";
```

### Built-in Components

| Component | Description |
|---|---|
| `Text` | Multi-line text with word wrapping |
| `Box` | Container with padding and background color |
| `Container` | Groups child components vertically |
| `Spacer` | Empty vertical space |
| `Markdown` | Renders markdown with syntax highlighting |
| `Image` | Renders images (Kitty/iTerm2/Ghostty/WezTerm) |
| `SelectList` | Scrollable, searchable list selection |
| `SettingsList` | Toggles for settings |
| `Input` / `Editor` | Text input with IME support |

### Component Interface

All components implement:

```typescript
interface Component {
  render(width: number): string[];    // MUST NOT exceed width per line
  handleInput?(data: string): void;
  wantsKeyRelease?: boolean;
  invalidate(): void;                 // Clear cached render state
}
```

### Keyboard Input

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

handleInput(data: string) {
  if (matchesKey(data, Key.up))      this.selectedIndex--;
  if (matchesKey(data, Key.down))    this.selectedIndex++;
  if (matchesKey(data, Key.enter))   this.onSelect?.(this.items[this.selectedIndex]);
  if (matchesKey(data, Key.escape))  this.onCancel?.();
  if (matchesKey(data, Key.ctrl("c"))) { /* ctrl+c */ }
}
```

### Line Width Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

render(width: number): string[] {
  return [truncateToWidth(this.text, width)];
}
```

### Theming

```typescript
renderResult(result, options, theme, context) {
  return new Text(theme.fg("success", "Done!"), 1, 0);
}
```

**Foreground colors:** `text`, `accent`, `muted`, `dim`, `success`, `error`, `warning`, `border`, `toolTitle`, `toolOutput`, `mdHeading`, `mdLink`, `syntaxKeyword`, etc.

**Background colors:** `selectedBg`, `userMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`

### Performance: Caching Renders

```typescript
class MyComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedLines = [/* compute */];
    this.cachedWidth = width;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

> ⚠️ Components that pre-bake theme colors must **rebuild content in `invalidate()`** — otherwise theme changes won't take effect. Call `super.invalidate()` first, then rebuild.

### Common UI Patterns

#### Pattern 1: Selection Dialog

```typescript
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

const items: SelectItem[] = [
  { value: "opt1", label: "Option 1", description: "First option" },
  { value: "opt2", label: "Option 2" },
];

const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  const container = new Container();
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", theme.bold("Pick an Option")), 1, 0));

  const selectList = new SelectList(items, 10, {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
  });
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(null);
  container.addChild(selectList);

  return {
    render: (w) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
  };
});
```

#### Pattern 2: Async Operation with Cancel

```typescript
import { BorderedLoader } from "@earendil-works/pi-coding-agent";

const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
  const loader = new BorderedLoader(tui, theme, "Fetching data...");
  loader.onAbort = () => done(null);

  fetchData(loader.signal)
    .then((data) => done(data))
    .catch(() => done(null));

  return loader;
});
```

#### Pattern 3: Settings Toggles

```typescript
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";

const items: SettingItem[] = [
  { id: "verbose", label: "Verbose mode", currentValue: "off", values: ["on", "off"] },
];

await ctx.ui.custom((_tui, theme, _kb, done) => {
  const settingsList = new SettingsList(items, 10, getSettingsListTheme(),
    (id, val) => ctx.ui.notify(`${id} = ${val}`, "info"),
    () => done(undefined),
    { enableSearch: true },
  );
  return {
    render: (w) => settingsList.render(w),
    invalidate: () => settingsList.invalidate?.(),
    handleInput: (data) => settingsList.handleInput?.(data),
  };
});
```

#### Pattern 4: Custom Editor (Vim Mode)

```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.mode === "insert") { this.mode = "normal"; return; }
      super.handleInput(data);
      return;
    }
    if (this.mode === "insert") { super.handleInput(data); return; }
    switch (data) {
      case "i": this.mode = "insert"; return;
      case "h": super.handleInput("\x1b[D"); return; // left
      case "l": super.handleInput("\x1b[C"); return; // right
    }
    super.handleInput(data);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new VimEditor(theme, keybindings));
  });
}
```

---

## Error Handling

- Errors thrown in event handlers are caught by Pi and logged, but do not crash the agent.
- Use `try/catch` for critical paths where you need to handle errors gracefully.
- In `tool_call`, returning `{ block: true, reason: "..." }` is preferred over throwing.
- Use `ctx.ui.notify("...", "error")` to surface errors to the user.

---

## Mode Behavior

Extensions behave differently across Pi's run modes:

| Mode | UI Available | Notes |
|---|---|---|
| Interactive | Full TUI | Normal operation |
| RPC (`--mode rpc`) | Yes (via protocol) | Dialog methods work via extension UI sub-protocol; fire-and-forget methods emit requests to client |
| JSON (`--mode json`) | No-op | Event stream to stdout; extensions run but can't prompt |
| Print (`-p`) | No-op | Extensions run; `ctx.hasUI` is `false` |

Check `ctx.hasUI` before showing UI:

```typescript
if (ctx.hasUI) {
  await ctx.ui.confirm("Title", "Proceed?");
} else {
  // Fallback: log or auto-proceed
}
```

---

## Packaging & Distribution

### Creating a Pi Package

Add a `pi` manifest to `package.json` and the `pi-package` keyword for gallery discoverability:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

Paths support glob patterns and `!exclusions`.

### Dependencies

- **Runtime deps** → `dependencies` (installed automatically via `npm install`)
- **Pi core packages** → `peerDependencies` with `"*"` range; do NOT bundle them:
  - `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`
- **Other pi packages you depend on** → `dependencies` + `bundledDependencies`

### Installing Packages

```bash
# From npm
pi install npm:@foo/bar@1.0.0

# From git
pi install git:github.com/user/repo@v1
pi install git:git@github.com:user/repo@v1.0.0

# From local path
pi install /absolute/path/to/package
pi install ./relative/path/to/package

# Temporary (not saved to settings)
pi -e npm:@foo/bar
```

**Management commands:**

```bash
pi remove npm:@foo/bar
pi list                      # list installed packages
pi update                    # update pi, packages, and git refs
pi update --extensions       # update packages only
pi update npm:@foo/bar       # update one package
```

By default, installs go to global settings (`~/.pi/agent/settings.json`). Use `-l` for project settings (`.pi/settings.json`).

### Package Filtering

Control which resources a package loads in `settings.json`:

```json
{
  "packages": [
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

---

## Examples Reference

All examples are in [github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/)

### Tools

| File | What It Shows | Key APIs |
|---|---|---|
| `hello.ts` | Minimal tool registration | `registerTool` |
| `question.ts` | Tool with user interaction | `registerTool`, `ui.select` |
| `questionnaire.ts` | Multi-step wizard tool | `registerTool`, `ui.custom` |
| `todo.ts` | Stateful tool with persistence | `registerTool`, `appendEntry`, `renderResult` |
| `dynamic-tools.ts` | Register tools after startup | `registerTool`, `session_start`, `registerCommand` |
| `structured-output.ts` | Final structured-output with terminate | `registerTool`, terminating tool results |
| `truncated-tool.ts` | Output truncation | `registerTool`, `truncateHead` |
| `tool-override.ts` | Override built-in read tool | `registerTool` (same name as built-in) |

### Commands

| File | What It Shows | Key APIs |
|---|---|---|
| `pirate.ts` | Modify system prompt per-turn | `registerCommand`, `before_agent_start` |
| `summarize.ts` | Conversation summary command | `registerCommand`, `ui.custom` |
| `handoff.ts` | Cross-provider model handoff | `registerCommand`, `ui.editor`, `ui.custom` |
| `qna.ts` | Q&A with custom UI | `registerCommand`, `ui.custom`, `setEditorText` |
| `send-user-message.ts` | Inject user messages | `registerCommand`, `sendUserMessage` |
| `reload-runtime.ts` | Reload command + LLM tool handoff | `registerCommand`, `ctx.reload()`, `sendUserMessage` |
| `shutdown-command.ts` | Graceful shutdown command | `registerCommand`, `shutdown()` |

### Events & Gates

| File | What It Shows | Key APIs |
|---|---|---|
| `permission-gate.ts` | Block dangerous commands | `on("tool_call")`, `ui.confirm` |
| `protected-paths.ts` | Block writes to specific paths | `on("tool_call")` |
| `confirm-destructive.ts` | Confirm session changes | `on("session_before_switch")` |
| `dirty-repo-guard.ts` | Warn on dirty git repo | `on("session_before_*")`, `exec` |
| `input-transform.ts` | Transform user input | `on("input")` |
| `model-status.ts` | React to model changes | `on("model_select")`, `setStatus` |
| `provider-payload.ts` | Inspect provider payloads | `on("before_provider_request")` |
| `system-prompt-header.ts` | Display system prompt info | `on("agent_start")`, `getSystemPrompt` |
| `claude-rules.ts` | Load rules from files | `on("session_start")`, `on("before_agent_start")` |
| `prompt-customizer.ts` | Context-aware tool guidance | `on("before_agent_start")`, `BuildSystemPromptOptions` |
| `file-trigger.ts` | File watcher triggers messages | `sendMessage` |

### UI Examples

| File | What It Shows | Key APIs |
|---|---|---|
| `preset.ts` | SelectList with DynamicBorder | `ui.custom`, `SelectList` |
| `timed-confirm.ts` | Timed dialog with countdown | `ui.confirm` with timeout |
| `overlay-qa-tests.ts` | Overlay anchors, margins, stacking | `ui.custom` with `overlay: true` |
| `plan-mode.ts` | Status indicators + widgets | `setStatus`, `setWidget` |
| `working-indicator.ts` | Custom working indicator | `setWorkingIndicator` |
| `custom-footer.ts` | Custom footer with stats | `setFooter` |
| `modal-editor.ts` | Vim-like modal editing | `setEditorComponent`, `CustomEditor` |
| `status-line.ts` | Persistent footer status | `setStatus` |
| `snake.ts` | Full game with keyboard + loop | `ui.custom` |
| `github-issue-autocomplete.ts` | GitHub autocomplete provider | `ui.registerAutocomplete` |

---

*Built from [pi.dev/docs/latest/extensions](https://pi.dev/docs/latest/extensions), [pi.dev/docs/latest/tui](https://pi.dev/docs/latest/tui), and [pi.dev/docs/latest/packages](https://pi.dev/docs/latest/packages).*
