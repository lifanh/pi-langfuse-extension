import { createHash } from "node:crypto";

export const REDACTED = "[REDACTED_SECRET]";

export interface RedactOptions {
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
  maxStringLength: number;
}

const DEFAULT_OPTIONS: RedactOptions = {
  maxDepth: 6,
  maxArrayItems: 50,
  maxObjectKeys: 80,
  maxStringLength: 12_000,
};

const SECRET_KEY_RE =
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASS|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH|COOKIE)[A-Z0-9_]*)\s*=\s*([^\s"'`]+)/gi;
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const KNOWN_TOKEN_RE =
  /\b(?:sk-(?:lf|ant|proj|live|test)[A-Za-z0-9_-]*|pk-lf-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const ABSOLUTE_PATH_RE =
  /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/tmp|\/tmp|[A-Za-z]:\\Users\\[^\\\s]+)(?:[^\s"'`]*)/g;

// Object keys are normalized (lowercased, with `_`/`-` stripped) before being
// checked against this set, so `apiKey`, `api_key`, `api-key`, and `APIKEY`
// all match the single `apikey` entry. Matching is exact-set membership, not
// substring, so benign keys like `tokenCount`/`maxTokens` are left alone.
const SENSITIVE_FIELD_NAMES = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "xapikey",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "sessiontoken",
  "idtoken",
  "bearertoken",
  "secret",
  "secretkey",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "privatekey",
  "credential",
  "credentials",
]);

// Fallback for a PRIVATE KEY block whose END marker was cut off by upstream
// truncation (or otherwise never appeared): redact from BEGIN to the end of
// the string rather than let the exposed prefix leak.
const UNTERMINATED_PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g;

// Regexes above already run in linear time per call, but guard against
// pathologically huge strings (e.g. multi-MB payloads) by capping the input
// to redaction well above the normal output limit before running them.
const PRE_REDACTION_LENGTH_MULTIPLIER = 10;

function normalizeFieldName(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function isSensitiveFieldName(key: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(normalizeFieldName(key));
}

export function hashPath(path: string): string {
  return `[PATH_HASH:${createHash("sha256").update(path).digest("hex").slice(0, 12)}]`;
}

function truncate(value: string, maxStringLength: number): string {
  return value.length > maxStringLength
    ? `${value.slice(0, maxStringLength)}... [truncated]`
    : value;
}

function redactString(value: string, options: RedactOptions): string {
  // Redact first, then truncate: truncating before redaction can slice a
  // secret in half, leaving its prefix exposed (and, for PRIVATE KEY blocks,
  // dropping the END marker so the block fails to match at all).
  const preRedactionLimit = options.maxStringLength * PRE_REDACTION_LENGTH_MULTIPLIER;
  const source = value.length > preRedactionLimit ? value.slice(0, preRedactionLimit) : value;

  const redacted = source
    .replace(PRIVATE_KEY_RE, REDACTED)
    .replace(BEARER_RE, REDACTED)
    .replace(KNOWN_TOKEN_RE, REDACTED)
    .replace(SECRET_KEY_RE, (_match, key: string) => `${key}=${REDACTED}`)
    .replace(ABSOLUTE_PATH_RE, (path: string) => {
      const envSuffix = path.match(/([/\\]\.env(?:\.[A-Za-z0-9_-]+)?)$/)?.[1];
      return `${hashPath(envSuffix ? path.slice(0, -envSuffix.length) : path)}${envSuffix ?? ""}`;
    })
    .replace(UNTERMINATED_PRIVATE_KEY_RE, REDACTED);

  return truncate(redacted, options.maxStringLength);
}

interface RedactedErrorObject {
  name: string;
  message: string;
  stack: string | undefined;
}

function visit(
  value: unknown,
  options: RedactOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
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
    const result: RedactedErrorObject = {
      name: redactString(value.name, options),
      message: redactString(value.message, options),
      stack: value.stack ? redactString(value.stack, options) : undefined,
    };
    return result;
  }

  if (typeof value !== "object") {
    return redactString(String(value), options);
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const output: unknown[] = value
      .slice(0, options.maxArrayItems)
      .map((item) => visit(item, options, depth - 1, seen));
    if (value.length > options.maxArrayItems) {
      output.push(`[${value.length - options.maxArrayItems} truncated items]`);
    }
    return output;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, options.maxObjectKeys)) {
    output[key] = isSensitiveFieldName(key)
      ? REDACTED
      : visit(item, options, depth - 1, seen);
  }
  if (entries.length > options.maxObjectKeys) {
    output["__truncatedKeys"] = entries.length - options.maxObjectKeys;
  }
  return output;
}

export function redactValue(
  value: unknown,
  options: Partial<RedactOptions> = {},
): unknown {
  const merged: RedactOptions = { ...DEFAULT_OPTIONS, ...options };
  return visit(value, merged, merged.maxDepth, new WeakSet());
}
