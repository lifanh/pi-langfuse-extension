import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension from "../index.js";
import { configPathForHome } from "../src/config.js";

type CommandHandler = (args: string, ctx: FakeCommandContext) => Promise<void>;

interface RegisteredCommand {
  description: string;
  handler: CommandHandler;
}

interface FakeCommandContext {
  hasUI: boolean;
  ui: {
    messages: Array<{ message: string; level: string }>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
    confirm(): Promise<boolean>;
    setStatus(key: string, text: string | undefined): void;
  };
}

function createPi(): { commands: Map<string, RegisteredCommand>; pi: any } {
  const commands = new Map<string, RegisteredCommand>();
  return {
    commands,
    pi: {
      registerCommand(name: string, command: RegisteredCommand): void {
        commands.set(name, command);
      },
      on(): void {
        // Event handlers are not needed for command tests.
      },
    },
  };
}

function createCtx(): FakeCommandContext {
  const messages: Array<{ message: string; level: string }> = [];
  return {
    hasUI: true,
    ui: {
      messages,
      notify(message: string, level: "info" | "warning" | "error" = "info"): void {
        messages.push({ message, level });
      },
      async confirm(): Promise<boolean> {
        return true;
      },
      setStatus(): void {
        // no-op
      },
    },
  };
}

function lastMessage(ctx: FakeCommandContext): string {
  return ctx.ui.messages.at(-1)?.message ?? "";
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const oldHome = process.env.HOME;
  const oldPublic = process.env.LANGFUSE_PUBLIC_KEY;
  const oldSecret = process.env.LANGFUSE_SECRET_KEY;
  const oldHost = process.env.LANGFUSE_HOST;
  const home = mkdtempSync(join(tmpdir(), "pi-langfuse-ux-"));
  process.env.HOME = home;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_HOST;
  try {
    return await fn(home);
  } finally {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    if (oldPublic === undefined) {
      delete process.env.LANGFUSE_PUBLIC_KEY;
    } else {
      process.env.LANGFUSE_PUBLIC_KEY = oldPublic;
    }
    if (oldSecret === undefined) {
      delete process.env.LANGFUSE_SECRET_KEY;
    } else {
      process.env.LANGFUSE_SECRET_KEY = oldSecret;
    }
    if (oldHost === undefined) {
      delete process.env.LANGFUSE_HOST;
    } else {
      process.env.LANGFUSE_HOST = oldHost;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("langfuse-configure merges with saved config instead of requiring keys", async () => {
  await withHome(async (home) => {
    const { commands, pi } = createPi();
    await extension(pi);
    const configure = commands.get("langfuse-configure");
    assert.ok(configure);

    const ctx = createCtx();
    await configure.handler("publicKey=pk-lf-public secretKey=sk-lf-secret host=https://cloud.langfuse.com", ctx);
    await configure.handler("captureInputs=true", ctx);

    const saved = JSON.parse(readFileSync(configPathForHome(home), "utf8"));
    assert.equal(saved.publicKey, "pk-lf-public");
    assert.equal(saved.secretKey, "sk-lf-secret");
    assert.equal(saved.host, "https://cloud.langfuse.com");
    assert.equal(saved.capture.LANGFUSE_CAPTURE_INPUTS, "true");
    assert.match(ctx.ui.messages.at(-1)?.message ?? "", /captureInputs=true/);
  });
});

test("commands reject unexpected arguments with usage guidance", async () => {
  await withHome(async () => {
    const { commands, pi } = createPi();
    await extension(pi);
    const status = commands.get("langfuse-status");
    const testCommand = commands.get("langfuse-test");
    assert.ok(status);
    assert.ok(testCommand);

    const ctx = createCtx();
    await status.handler("verbose=true", ctx);
    assert.equal(ctx.ui.messages.at(-1)?.level, "warning");
    assert.match(lastMessage(ctx), /Unexpected argument 'verbose'/);
    assert.match(lastMessage(ctx), /Usage: \/langfuse-status/);
    assert.match(lastMessage(ctx), /Run \/langfuse-status without arguments/);

    await testCommand.handler("now", ctx);
    assert.equal(ctx.ui.messages.at(-1)?.level, "warning");
    assert.match(lastMessage(ctx), /Unexpected argument 'now'/);
    assert.match(lastMessage(ctx), /Usage: \/langfuse-test/);
    assert.match(lastMessage(ctx), /Run \/langfuse-test without arguments/);
  });
});

test("registers only configure, status, and test commands", async () => {
  await withHome(async () => {
    const { commands, pi } = createPi();
    await extension(pi);

    assert.deepEqual([...commands.keys()].sort(), [
      "langfuse-configure",
      "langfuse-status",
      "langfuse-test",
    ]);
    assert.equal(commands.has("langfuse-privacy"), false);
    assert.equal(commands.has("langfuse-reset"), false);
  });
});

test("langfuse-configure reports malformed and unknown arguments with examples", async () => {
  await withHome(async () => {
    const { commands, pi } = createPi();
    await extension(pi);
    const configure = commands.get("langfuse-configure");
    assert.ok(configure);

    const ctx = createCtx();
    await configure.handler("publicKey pk-lf-public secretKey=sk-lf-secret", ctx);
    assert.equal(ctx.ui.messages.at(-1)?.level, "warning");
    assert.match(lastMessage(ctx), /Couldn't understand 'publicKey'/);
    assert.match(lastMessage(ctx), /Use key=value, for example publicKey=pk-lf-/);
    assert.match(lastMessage(ctx), /Usage: \/langfuse-configure/);

    await configure.handler("publicKey=pk-lf-public secretKey=sk-lf-secret region=us", ctx);
    assert.equal(ctx.ui.messages.at(-1)?.level, "warning");
    assert.match(lastMessage(ctx), /Unknown setting 'region'/);
    assert.match(lastMessage(ctx), /Allowed settings: publicKey, secretKey, host, captureInputs, captureOutputs, captureToolIo, captureSystemPrompt, captureCwd, debug/);
    assert.match(lastMessage(ctx), /Usage: \/langfuse-configure/);
    assert.match(lastMessage(ctx), /debug=true/);
    assert.match(lastMessage(ctx), /Example: \/langfuse-configure captureInputs=true/);
  });
});

test("langfuse-configure validates boolean capture flags before saving", async () => {
  await withHome(async (home) => {
    const { commands, pi } = createPi();
    await extension(pi);
    const configure = commands.get("langfuse-configure");
    assert.ok(configure);

    const ctx = createCtx();
    await configure.handler(
      "publicKey=pk-lf-public secretKey=sk-lf-secret captureInputs=yes",
      ctx,
    );
    assert.equal(ctx.ui.messages.at(-1)?.level, "warning");
    assert.match(lastMessage(ctx), /Invalid value for captureInputs='yes'/);
    assert.match(lastMessage(ctx), /Use captureInputs=true or captureInputs=false/);
    assert.match(lastMessage(ctx), /Usage: \/langfuse-configure/);
    assert.throws(() => readFileSync(configPathForHome(home), "utf8"), /ENOENT/);
  });
});

test("langfuse-status reports minimal metadata tracing and config source", async () => {
  await withHome(async () => {
    const { commands, pi } = createPi();
    await extension(pi);
    const configure = commands.get("langfuse-configure");
    const status = commands.get("langfuse-status");
    assert.ok(configure);
    assert.ok(status);

    const ctx = createCtx();
    await configure.handler("publicKey=pk-lf-public secretKey=sk-lf-secret captureOutputs=true", ctx);
    await status.handler("", ctx);

    const message = ctx.ui.messages.at(-1)?.message ?? "";
    assert.match(message, /State:\s+configured ✓/);
    assert.match(message, /Source:\s+config file/);
    assert.match(message, /Capture mode:\s+custom/);
    assert.match(message, /Content capture:/);
    assert.match(message, /captureInputs:\s+off/);
    assert.match(message, /captureOutputs:\s+on/);
    assert.match(message, /Minimal metadata sent:/);
    assert.match(message, /generation: model, parameters, usage, cost, status, stop reason, turn index/);
    assert.match(message, /Last error:/);
  });
});
