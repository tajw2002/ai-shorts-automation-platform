import { randomBytes, createHash } from 'node:crypto';

/** 256 bits of entropy, URL-safe. Used for session and OAuth state tokens. */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Sessions are stored as a hash, never in plaintext, so a database dump does not
 * yield usable session cookies.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Deterministic idempotency key. Two enqueues describing the same unit of work
 * collapse to one row, which is what makes at-least-once delivery safe.
 */
export function buildIdempotencyKey(parts: Array<string | number | null | undefined>): string {
  const joined = parts.map((p) => String(p ?? '')).join('|');
  // Hashed so the key stays within the column bound regardless of input length.
  return createHash('sha256').update(joined).digest('hex').slice(0, 48);
}
