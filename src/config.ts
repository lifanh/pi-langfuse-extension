import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  createCapturePolicy,
  type CapturePolicy,
  type EnvLike,
} from "./capture-policy.js";
import { REDACTED } from "./redaction.js";

export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host: string;
  capturePolicy: CapturePolicy;
}

export interface SanitizedConfig {
  publicKey: string;
  secretKey: string;
  host: string;
}

export interface PersistedConfigInput {
  publicKey: string;
  secretKey: string;
  host?: string;
  capture?: Record<string, string | undefined>;
}

interface PersistedConfigFile {
  publicKey?: unknown;
  secretKey?: unknown;
  host?: unknown;
  capture?: unknown;
}

export function configPathForHome(home: string = homedir()): string {
  return resolve(
    home,
    ".pi",
    "agent",
    "@lifanh",
    "pi-langfuse-extension",
    "config.json",
  );
}

export function loadConfigFromEnv(
  env: EnvLike = process.env as EnvLike,
): LangfuseConfig | null {
  const publicKey = env["LANGFUSE_PUBLIC_KEY"];
  const secretKey = env["LANGFUSE_SECRET_KEY"];
  if (!publicKey || !secretKey) {
    return null;
  }

  return {
    publicKey,
    secretKey,
    host:
      env["LANGFUSE_HOST"] ||
      env["LANGFUSE_BASE_URL"] ||
      DEFAULT_LANGFUSE_HOST,
    capturePolicy: createCapturePolicy(env),
  };
}

export function loadConfigFromFile(
  path: string = configPathForHome(),
): LangfuseConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedConfigFile;
    if (
      typeof parsed.publicKey !== "string" ||
      typeof parsed.secretKey !== "string" ||
      !parsed.publicKey ||
      !parsed.secretKey
    ) {
      return null;
    }
    const host =
      typeof parsed.host === "string" && parsed.host
        ? parsed.host
        : DEFAULT_LANGFUSE_HOST;
    const captureSource =
      parsed.capture && typeof parsed.capture === "object"
        ? (parsed.capture as EnvLike)
        : ({} as EnvLike);
    return {
      publicKey: parsed.publicKey,
      secretKey: parsed.secretKey,
      host,
      capturePolicy: createCapturePolicy(captureSource),
    };
  } catch {
    return null;
  }
}

export function loadConfig(
  env: EnvLike = process.env as EnvLike,
  path: string = configPathForHome(),
): LangfuseConfig | null {
  return loadConfigFromEnv(env) ?? loadConfigFromFile(path);
}

export function saveConfig(
  config: PersistedConfigInput,
  path: string = configPathForHome(),
): void {
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

function maskPublicKey(value: string): string {
  if (!value || value.length <= 8) {
    return REDACTED;
  }
  return `${value.slice(0, 5)}...${value.slice(-4)}`;
}

export function sanitizeConfigForLog(
  config: Pick<LangfuseConfig, "publicKey" | "secretKey" | "host"> | null,
): SanitizedConfig | null {
  if (!config) {
    return null;
  }
  return {
    publicKey: maskPublicKey(config.publicKey),
    secretKey: REDACTED,
    host: config.host || DEFAULT_LANGFUSE_HOST,
  };
}
