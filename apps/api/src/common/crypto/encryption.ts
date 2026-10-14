import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  createHash,
} from 'node:crypto';

/**
 * Authenticated symmetric encryption for secrets at rest — specifically OAuth
 * refresh tokens.
 *
 * Format: `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`. The version prefix exists so a
 * future algorithm change can be rolled out without a flag day: new writes use the
 * new version, reads dispatch on the prefix.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the value GCM is specified for.
const TAG_BYTES = 16;
const VERSION = 'v1';

export class EncryptionService {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM.');
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 4) {
      throw new Error('Malformed ciphertext: expected 4 colon-separated segments.');
    }
    const [version, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
    if (version !== VERSION) {
      throw new Error(`Unsupported ciphertext version '${version}'.`);
    }

    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error('Malformed ciphertext: bad IV or auth tag length.');
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    // `final()` throws if the tag does not verify, which is exactly the
    // tamper-detection we want.
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** True when the value looks like something this service produced. */
  static isEncrypted(value: string): boolean {
    return value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
  }
}

/** Constant-time comparison for secrets that arrive as strings (tokens, keys). */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // Hash first so differing lengths do not leak via an early return.
  const hashA = createHash('sha256').update(bufA).digest();
  const hashB = createHash('sha256').update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
