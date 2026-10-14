import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt.
 *
 * scrypt is memory-hard, is in Node's standard library (no native build step, no
 * supply-chain surface) and is an accepted choice alongside Argon2/bcrypt. The
 * cost parameters are stored inside the hash so they can be raised over time
 * without invalidating existing passwords.
 */

/** OWASP-aligned baseline: N=2^16, r=8, p=1 (~64 MB of memory per hash). */
const DEFAULT_PARAMS = { N: 65_536, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** scrypt needs roughly 128 * N * r bytes; give it headroom. */
const maxmemFor = (N: number, r: number) => 256 * N * r;

export interface PasswordParams {
  N: number;
  r: number;
  p: number;
}

export async function hashPassword(
  password: string,
  params: PasswordParams = DEFAULT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...params,
    maxmem: maxmemFor(params.N, params.r),
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must not
 * turn into a 500 that tells an attacker the account exists.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters that would let a crafted row exhaust memory.
  if (N < 1024 || N > 1 << 22 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when a stored hash was produced with weaker parameters than we now use. */
export function needsRehash(stored: string, params: PasswordParams = DEFAULT_PARAMS): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < params.N;
}
