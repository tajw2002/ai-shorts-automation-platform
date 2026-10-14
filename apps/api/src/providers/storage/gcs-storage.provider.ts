import { Injectable } from '@nestjs/common';
import { Storage, type Bucket } from '@google-cloud/storage';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { AppConfig } from '@/config/app-config';
import { type ByteRange } from '@/common/utils/http-range';
import { NotFoundError, ProviderError } from '@/common/errors';
import { errorHealth, okHealth, type ProviderHealth } from '../provider.types';
import {
  type StorageProvider,
  type StoredObject,
  type UploadOptions,
} from './storage-provider.interface';

/**
 * Google Cloud Storage adapter.
 *
 * Objects are private. The dashboard receives short-lived V4 signed URLs rather
 * than public links, so a leaked URL expires on its own and a leaked *object path*
 * is worthless.
 */
@Injectable()
export class GcsStorageProvider implements StorageProvider {
  readonly name = 'gcs';
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor(private readonly config: AppConfig) {
    this.bucketName = config.storage.gcsBucket;
    this.storage = new Storage({
      projectId: config.storage.gcsProjectId || undefined,
      // Left undefined on Cloud Run so Application Default Credentials
      // (the attached service account) are used — no key file to leak.
      keyFilename: config.storage.credentialsPath || undefined,
    });
  }

  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!this.config.storage.gcsBucket) missing.push('GCS_BUCKET');
    return missing;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const [exists] = await this.bucket().exists();
      return exists
        ? okHealth(`Bucket ${this.bucketName} reachable`, Date.now() - startedAt)
        : errorHealth(`Bucket ${this.bucketName} does not exist or is not visible.`);
    } catch (error) {
      return errorHealth(
        `GCS unreachable: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  describe(): Record<string, string | number | boolean | null> {
    return {
      bucket: this.bucketName,
      projectId: this.config.storage.gcsProjectId || null,
      durable: true,
      signedUrls: true,
    };
  }

  async upload(
    key: string,
    body: Buffer | Readable,
    options: UploadOptions,
  ): Promise<StoredObject> {
    const file = this.bucket().file(key);
    const writeStream = file.createWriteStream({
      resumable: false,
      contentType: options.contentType,
      metadata: { metadata: options.metadata ?? {} },
    });

    await pipeline(Buffer.isBuffer(body) ? Readable.from(body) : body, writeStream);
    if (options.publicRead) await file.makePublic();

    return this.toStoredObject(key, options.contentType, options.publicRead ?? false);
  }

  async uploadFromFile(
    key: string,
    sourcePath: string,
    options: UploadOptions,
  ): Promise<StoredObject> {
    // Resumable for files on disk: a dropped connection mid-upload of a large
    // render should not mean starting over.
    await this.bucket().upload(sourcePath, {
      destination: key,
      resumable: true,
      contentType: options.contentType,
      metadata: { metadata: options.metadata ?? {} },
    });
    if (options.publicRead) await this.bucket().file(key).makePublic();
    return this.toStoredObject(key, options.contentType, options.publicRead ?? false);
  }

  async download(key: string, range?: ByteRange): Promise<Readable> {
    const file = this.bucket().file(key);
    const [exists] = await file.exists();
    if (!exists) throw new NotFoundError('Stored object', key);
    return file.createReadStream(range ? { start: range.start, end: range.end } : undefined);
  }

  async downloadToFile(key: string, destinationPath: string): Promise<void> {
    await mkdir(dirname(destinationPath), { recursive: true });
    const file = this.bucket().file(key);
    const [exists] = await file.exists();
    if (!exists) throw new NotFoundError('Stored object', key);
    await pipeline(file.createReadStream(), createWriteStream(destinationPath));
  }

  async exists(key: string): Promise<boolean> {
    const [exists] = await this.bucket().file(key).exists();
    return exists;
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const [metadata] = await this.bucket().file(key).getMetadata();
      return {
        key,
        sizeBytes: Number(metadata.size ?? 0),
        contentType: metadata.contentType ?? 'application/octet-stream',
        // GCS reports MD5/CRC32C, not SHA-256; we record our own on write.
        checksumSha256: null,
        publicUrl: null,
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.bucket()
      .file(key)
      .delete({ ignoreNotFound: true })
      .catch((error: unknown) => {
        throw new ProviderError({
          provider: this.name,
          message: `Failed to delete ${key}`,
          cause: error,
          retryable: true,
        });
      });
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const [url] = await this.bucket()
      .file(key)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + ttlSeconds * 1000,
      });
    return url;
  }

  private bucket(): Bucket {
    return this.storage.bucket(this.bucketName);
  }

  private async toStoredObject(
    key: string,
    contentType: string,
    publicRead: boolean,
  ): Promise<StoredObject> {
    const [metadata] = await this.bucket().file(key).getMetadata();
    return {
      key,
      sizeBytes: Number(metadata.size ?? 0),
      contentType,
      checksumSha256: null,
      publicUrl: publicRead
        ? `https://storage.googleapis.com/${this.bucketName}/${encodeURI(key)}`
        : null,
    };
  }
}
