import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { createCapturePolicy } from "./capture-policy.js";
import { REDACTED } from "./redaction.js";

export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

export function configPathForHome(home = homedir()) {
  return resolve(home, ".pi", "agent", "@lifanh", "pi-langfuse", "config.json");
}

export function loadConfigFromEnv(env = process.env) {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    return null;
  }

  return {
    publicKey,
    secretKey,
    host: env.LANGFUSE_HOST || env.LANGFUSE_BASE_URL || DEFAULT_LANGFUSE_HOST,
    capturePolicy: createCapturePolicy(env),
  };
}

export function loadConfigFromFile(path = configPathForHome()) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed.publicKey || !parsed.secretKey) {
      return null;
    }
    return {
      publicKey: parsed.publicKey,
      secretKey: parsed.secretKey,
      host: parsed.host || DEFAULT_LANGFUSE_HOST,
      capturePolicy: createCapturePolicy(parsed.capture ?? {}),
    };
  } catch {
    return null;
  }
}

export function loadConfig(env = process.env, path = configPathForHome()) {
  return loadConfigFromEnv(env) || loadConfigFromFile(path);
}

export function saveConfig(config, path = configPathForHome()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        host: config.host || DEFAULT_LANGFUSE_HOST,
        capture: config.capture ?? {},
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function maskPublicKey(value) {
  if (!value || value.length <= 8) {
    return REDACTED;
  }
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

export function sanitizeConfigForLog(config) {
  if (!config) {
    return null;
  }
  return {
    publicKey: maskPublicKey(config.publicKey),
    secretKey: REDACTED,
    host: config.host || DEFAULT_LANGFUSE_HOST,
  };
}
