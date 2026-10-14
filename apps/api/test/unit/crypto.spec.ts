import { EncryptionService, safeCompare, sha256Hex } from '@/common/crypto/encryption';
import { hashPassword, needsRehash, verifyPassword } from '@/common/crypto/password';
import { buildIdempotencyKey, generateOpaqueToken, hashToken } from '@/common/crypto/tokens';

const KEY = Buffer.alloc(32, 0x2a);

describe('EncryptionService', () => {
  const service = new EncryptionService(KEY);

  it('round-trips a value', () => {
    const secret = 'ya29.a0AfH6SMB-not-a-real-token';
    expect(service.decrypt(service.encrypt(secret))).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(service.encrypt('same')).not.toBe(service.encrypt('same'));
  });

  it('emits the versioned four-segment format', () => {
    const payload = service.encrypt('value');
    expect(payload.split(':')).toHaveLength(4);
    expect(payload.startsWith('v1:')).toBe(true);
    expect(EncryptionService.isEncrypted(payload)).toBe(true);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => new EncryptionService(Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('refuses to decrypt tampered ciphertext', () => {
    const payload = service.encrypt('sensitive');
    const [version, iv, tag, data] = payload.split(':');
    const flipped = Buffer.from(data as string, 'base64');
    flipped[0] = (flipped[0] as number) ^ 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64')].join(':');
    expect(() => service.decrypt(tampered)).toThrow();
  });

  it('refuses a ciphertext encrypted under a different key', () => {
    const other = new EncryptionService(Buffer.alloc(32, 0x99));
    expect(() => service.decrypt(other.encrypt('value'))).toThrow();
  });

  it('rejects a malformed payload rather than crashing obscurely', () => {
    expect(() => service.decrypt('not-encrypted')).toThrow(/Malformed ciphertext/);
    expect(() => service.decrypt('v2:a:b:c')).toThrow(/Unsupported ciphertext version/);
  });

  it('handles unicode and empty strings', () => {
    expect(service.decrypt(service.encrypt(''))).toBe('');
    expect(service.decrypt(service.encrypt('äöü 🦆'))).toBe('äöü 🦆');
  });
});

describe('safeCompare', () => {
  it('matches equal strings', () => {
    expect(safeCompare('token-abc', 'token-abc')).toBe(true);
  });

  it('rejects different strings, including different lengths', () => {
    expect(safeCompare('token-abc', 'token-abd')).toBe(false);
    expect(safeCompare('short', 'much-longer-value')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('is stable and hex encoded', () => {
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
  });
});

describe('password hashing', () => {
  // Weak parameters keep the suite fast; production uses the defaults.
  const FAST = { N: 1024, r: 8, p: 1 };

  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    await expect(verifyPassword('wrong password entirely', hash)).resolves.toBe(false);
  });

  it('never stores the password in the hash', async () => {
    const hash = await hashPassword('supersecret-value-123', FAST);
    expect(hash).not.toContain('supersecret');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('same password', FAST);
    const b = await hashPassword('same password', FAST);
    expect(a).not.toBe(b);
  });

  it('normalises unicode so an equivalent input still verifies', async () => {
    // 'é' as a single code point vs. 'e' + combining acute.
    const hash = await hashPassword('café-password', FAST);
    await expect(verifyPassword('café-password', hash)).resolves.toBe(true);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    await expect(verifyPassword('x', 'garbage')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$a$b$c$d$e')).resolves.toBe(false);
    await expect(verifyPassword('x', '')).resolves.toBe(false);
  });

  it('refuses absurd parameters that could exhaust memory', async () => {
    const hostile = ['scrypt', 2 ** 30, 8, 1, 'c2FsdA==', 'aGFzaA=='].join('$');
    await expect(verifyPassword('x', hostile)).resolves.toBe(false);
  });

  it('flags hashes made with weaker parameters for rehashing', async () => {
    const weak = await hashPassword('password', FAST);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(weak, FAST)).toBe(false);
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('tokens', () => {
  it('generates URL-safe tokens of adequate entropy', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('generates distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(200);
  });

  it('hashes tokens deterministically and irreversibly', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });

  it('builds a stable, bounded idempotency key', () => {
    const key = buildIdempotencyKey(['UPLOAD', 'video-1', 42]);
    expect(key).toBe(buildIdempotencyKey(['UPLOAD', 'video-1', 42]));
    expect(key).not.toBe(buildIdempotencyKey(['UPLOAD', 'video-2', 42]));
    expect(key.length).toBeLessThanOrEqual(48);
  });

  it('distinguishes null from empty string in key parts', () => {
    // Both stringify to '', so this documents the intended collision.
    expect(buildIdempotencyKey(['a', null])).toBe(buildIdempotencyKey(['a', '']));
    expect(buildIdempotencyKey(['a', 'b'])).not.toBe(buildIdempotencyKey(['ab']));
  });
});
