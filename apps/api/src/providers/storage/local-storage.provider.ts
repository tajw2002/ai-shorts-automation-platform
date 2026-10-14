import { Injectable } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { AppConfig } from '@/config/app-config';
import { type ByteRange } from '@/common/utils/http-range';
import { NotFoundError, ValidationError } from '@/common/errors';
import { okHealth, errorHealth, type ProviderHealth } from '../provider.types';
import {
  type StorageProvider,
  type StoredObject,
  type UploadOptions,
} from './storage-provider.interface';

/**
 * Filesystem-backed storage for local development.
 *
 * Not durable on Cloud Run — the config schema rejects it in production — but it
 * lets the whole pipeline run on a laptop with no cloud account at all.
 *
 * Every key is resolved against the configured root and checked afterwards, so a
 * key containing `../` cannot escape the storage directory.
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local';
  private readonly root: string;

  constructor(config: AppConfig) {
    this.root = resolve(config.storage.localRoot);
  }

  isConfigured(): boolean {
    return true;
  }

  missingConfiguration(): string[] {
    return [];
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      await mkdir(this.root, { recursive: true });
      await access(this.root);
      return okHealth(`Writable at ${this.root}`, Date.now() - startedAt);
    } catch (error) {
      return errorHealth(
        `Storage root ${this.root} is not writable: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  describe(): Record<string, string | number | boolean | null> {
    return { root: this.root, durable: false, signedUrls: false };
  }

  async upload(
    key: string,
    body: Buffer | Readable,
    options: UploadOptions,
  ): Promise<StoredObject> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });

    const hash = createHash('sha256');
    let sizeBytes = 0;

    const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
    // Hash and measure while the bytes flow past, so a large render is never
    // buffered in memory just to compute a checksum.
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });

    await pipeline(source, measure, createWriteStream(path));

    return {
      key,
      sizeBytes,
      contentType: options.contentType,
      checksumSha256: hash.digest('hex'),
      publicUrl: null,
    };
  }

  async uploadFromFile(
    key: string,
    sourcePath: string,
    options: UploadOptions,
  ): Promise<StoredObject> {
    return this.upload(key, createReadStream(sourcePath), options);
  }

  async download(key: string, range?: ByteRange): Promise<Readable> {
    const path = this.resolveKey(key);
    if (!(await this.pathExists(path))) throw new NotFoundError('Stored object', key);
    return createReadStream(path, range ? { start: range.start, end: range.end } : undefined);
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    const path = this.resolveKey(key);
    if (!(await this.pathExists(path))) throw new NotFoundError('Stored object', key);
    await mkdir(dirname(destinationPath), { recursive: true });
    await pipeline(createReadStream(path), createWriteStream(destinationPath));
  }

  async exists(key: string): Promise<boolean> {
    return this.pathExists(this.resolveKey(key));
  }

  async stat(key: string): Promise<StoredObject | null> {
    const path = this.resolveKey(key);
    try {
      const stats = await stat(path);
      return {
        key,
        sizeBytes: stats.size,
        contentType: 'application/octet-stream',
        checksumSha256: null,
        publicUrl: null,
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  /**
   * There is no signing to do locally, so the API serves the bytes itself from an
   * authenticated route. The token is the caller's session, not a URL secret.
   */
  async getSignedUrl(key: string): Promise<string> {
    return `/api/v1/assets/content?key=${encodeURIComponent(key)}`;
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /** Rejects absolute keys and any traversal that would leave the storage root. */
  private resolveKey(key: string): string {
    if (!key || key.trim().length === 0)
      throw new ValidationError('Storage key must not be empty.');
    if (isAbsolute(key)) throw new ValidationError('Storage key must be relative.');

    const resolved = resolve(join(this.root, normalize(key)));
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
      throw new ValidationError('Storage key escapes the storage root.');
    }
    return resolved;
  }
}
