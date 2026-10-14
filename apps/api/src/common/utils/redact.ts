/**
 * Redaction applied to everything that reaches a log sink or a persisted
 * SystemLog row. Secrets must never appear in logs, and this enforces it in one
 * place rather than relying on every caller to remember.
 */

/** Keys whose values are replaced wholesale, matched case-insensitively. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|api[_-]?key|authorization|auth|credential|cookie|session|refresh|private[_-]?key|client[_-]?secret|signature)/i;

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 2000;

/** Patterns that look like credentials even when the key name is innocuous. */
const VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Bearer tokens and generic long opaque secrets in free text.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, replacement: 'Bearer [redacted]' },
  // Google OAuth refresh/access tokens.
  { pattern: /\b(1\/\/|ya29\.)[A-Za-z0-9._~+/-]{10,}/g, replacement: REDACTED },
  // Provider-style API keys.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replacement: REDACTED },
  // Credentials embedded in a connection string or URL.
  { pattern: /(:\/\/)([^:/@\s]+):([^@\s]+)@/g, replacement: '$1$2:[redacted]@' },
];

export function redactString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of VALUE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result.length > MAX_STRING_LENGTH
    ? `${result.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : result;
}

/**
 * Deep-redacts an arbitrary value. Cycles are broken, depth is bounded, and
 * anything non-serialisable degrades to a placeholder rather than throwing —
 * logging must never be the thing that takes the process down.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[max depth]';

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => redact(item, depth + 1, seen));
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1, seen);
    }
    return result;
  }

  return '[unknown]';
}

/** Paths handed to pino's built-in redaction, complementing `redact()`. */
export const PINO_REDACT_PATHS = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.refreshToken',
  '*.accessToken',
  '*.clientSecret',
  '*.refreshTokenEnc',
  '*.accessTokenEnc',
]);
