import { createHash } from "node:crypto";

export const REDACTED = "[REDACTED_SECRET]";

const DEFAULT_OPTIONS = {
  maxDepth: 6,
  maxArrayItems: 50,
  maxObjectKeys: 80,
  maxStringLength: 12_000,
};

const SECRET_KEY_RE = /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASS|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|COOKIE)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const KNOWN_TOKEN_RE =
  /\b(?:sk-(?:lf|ant|proj|live|test)[A-Za-z0-9_-]*|pk-lf-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const ABSOLUTE_PATH_RE = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/tmp|\/tmp|[A-Za-z]:\\Users\\[^\\\s]+)(?:[^\s"'`]*)/g;
const SENSITIVE_FIELD_RE = /^(authorization|cookie|set-cookie|x-api-key|api-key|token|access_token|refresh_token|secret|secretkey|password|passwd|privatekey)$/i;

export function hashPath(path) {
  return `[PATH_HASH:${createHash("sha256").update(String(path)).digest("hex").slice(0, 12)}]`;
}

function truncate(value, maxStringLength) {
  return value.length > maxStringLength ? `${value.slice(0, maxStringLength)}... [truncated]` : value;
}

function redactString(value, options) {
  const truncated = truncate(value, options.maxStringLength);
  return truncated
    .replace(PRIVATE_KEY_RE, REDACTED)
    .replace(BEARER_RE, REDACTED)
    .replace(KNOWN_TOKEN_RE, REDACTED)
    .replace(SECRET_KEY_RE, (_match, key) => `${key}=${REDACTED}`)
    .replace(ABSOLUTE_PATH_RE, (path) => {
      const envSuffix = path.match(/([/\\]\.env(?:\.[A-Za-z0-9_-]+)?)$/)?.[1];
      return `${hashPath(envSuffix ? path.slice(0, -envSuffix.length) : path)}${envSuffix ?? ""}`;
    });
}

function visit(value, options, depth, seen) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return redactString(value, options);
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }

  if (depth <= 0) {
    return `[max depth ${options.maxDepth} reached]`;
  }

  if (value instanceof Error) {
    return {
      name: redactString(value.name, options),
      message: redactString(value.message, options),
      stack: value.stack ? redactString(value.stack, options) : undefined,
    };
  }

  if (typeof value !== "object") {
    return redactString(String(value), options);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const output = value.slice(0, options.maxArrayItems).map((item) => visit(item, options, depth - 1, seen));
    if (value.length > options.maxArrayItems) {
      output.push(`[${value.length - options.maxArrayItems} truncated items]`);
    }
    return output;
  }

  const entries = Object.entries(value);
  const output = {};
  for (const [key, item] of entries.slice(0, options.maxObjectKeys)) {
    output[key] = SENSITIVE_FIELD_RE.test(key) ? REDACTED : visit(item, options, depth - 1, seen);
  }
  if (entries.length > options.maxObjectKeys) {
    output.__truncatedKeys = entries.length - options.maxObjectKeys;
  }
  return output;
}

export function redactValue(value, options = {}) {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  return visit(value, merged, merged.maxDepth, new WeakSet());
}
