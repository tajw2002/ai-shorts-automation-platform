import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { type Readable, Transform } from 'node:stream';
import { type AssetKind, type LicenseStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { STORAGE_PROVIDER } from '@/providers/provider.tokens';
import {
  type StorageProvider,
  type StoredObject,
} from '@/providers/storage/storage-provider.interface';
import { type ByteRange } from '@/common/utils/http-range';
import { NotFoundError } from '@/common/errors';

/**
 * Asset storage with mandatory provenance.
 *
 * Every binary the platform holds is recorded with where it came from and under
 * what licence. `LicenseStatus.UNKNOWN` is a legitimate value — it just makes the
 * video unpublishable, which is the point: provenance is proven, not assumed.
 *
 * Storage keys are namespaced by video so an entire video's material can be
 * located, previewed, or deleted as a unit.
 */

/** Preview links expire quickly; the dashboard re-requests as needed. */
const SIGNED_URL_TTL_SECONDS = 3600;

export interface StoreAssetInput {
  videoId: string | null;
  kind: AssetKind;
  contentType: string;
  sourceProvider: string;
  sourceModel?: string | null;
  sourceReference?: string | null;
  licenseStatus: LicenseStatus;
  licenseNote?: string | null;
  licenseUrl?: string | null;
  durationSeconds?: number | null;
}

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /** Uploads a buffer and records it. */
  async storeBuffer(input: StoreAssetInput, data: Buffer, filename: string) {
    const key = this.buildKey(input, filename);
    const stored = await this.storage.upload(key, data, {
      contentType: input.contentType,
      metadata: this.provenanceMetadata(input),
    });

    return this.record(input, key, stored.sizeBytes, stored.checksumSha256 ?? sha256(data));
  }

  /** Uploads a file already on disk, streaming so a large render stays off the heap. */
  async storeFile(input: StoreAssetInput, sourcePath: string, filename: string) {
    const key = this.buildKey(input, filename);
    const stored = await this.storage.uploadFromFile(key, sourcePath, {
      contentType: input.contentType,
      metadata: this.provenanceMetadata(input),
    });

    const size = stored.sizeBytes || (await stat(sourcePath)).size;
    return this.record(input, key, size, stored.checksumSha256);
  }

  /**
   * Streams a provider download straight into storage, hashing on the way past.
   *
   * The clip is never fully materialised in memory, which matters because a
   * pipeline instance may be processing several scenes at once.
   */
  async storeStream(
    input: StoreAssetInput,
    stream: Readable,
    filename: string,
  ): Promise<Awaited<ReturnType<AssetsService['record']>>> {
    const key = this.buildKey(input, filename);
    const hash = createHash('sha256');
    let sizeBytes = 0;

    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });

    const stored = await this.storage.upload(key, stream.pipe(measure), {
      contentType: input.contentType,
      metadata: this.provenanceMetadata(input),
    });

    return this.record(
      input,
      key,
      stored.sizeBytes || sizeBytes,
      stored.checksumSha256 ?? hash.digest('hex'),
    );
  }

  /** Materialises an asset on local disk — what ffmpeg needs. */
  async downloadToFile(assetId: string, destinationPath: string): Promise<string> {
    const asset = await this.findById(assetId);
    await mkdir(dirname(destinationPath), { recursive: true });
    await this.storage.downloadToFile(asset.storageKey, destinationPath);
    return destinationPath;
  }

  /** Downloads by key, for callers that already hold one. */
  async downloadKeyToFile(key: string, destinationPath: string): Promise<string> {
    await mkdir(dirname(destinationPath), { recursive: true });
    await this.storage.downloadToFile(key, destinationPath);
    return destinationPath;
  }

  async findById(id: string) {
    const asset = await this.prisma.asset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundError('Asset', id);
    return asset;
  }

  async findForVideo(videoId: string, kind?: AssetKind) {
    return this.prisma.asset.findMany({
      where: { videoId, ...(kind ? { kind } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findLatestForVideo(videoId: string, kind: AssetKind) {
    return this.prisma.asset.findFirst({
      where: { videoId, kind },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Time-limited preview URL. Assets are never made public. */
  async getPreviewUrl(assetId: string): Promise<string> {
    const asset = await this.findById(assetId);
    return this.storage.getSignedUrl(asset.storageKey, SIGNED_URL_TTL_SECONDS);
  }

  async getPreviewUrlForKey(key: string): Promise<string> {
    return this.storage.getSignedUrl(key, SIGNED_URL_TTL_SECONDS);
  }

  /** Opens a read stream — used by the local-storage content route. */
  async openStream(key: string, range?: ByteRange): Promise<Readable> {
    return this.storage.download(key, range);
  }

  /** Size and type of a stored object, or `null` when it does not exist. */
  async statObject(key: string): Promise<StoredObject | null> {
    return this.storage.stat(key);
  }

  async remove(assetId: string): Promise<void> {
    const asset = await this.findById(assetId);
    await this.storage.delete(asset.storageKey).catch((error: unknown) => {
      // A missing object is the desired end state; do not block the DB cleanup.
      this.logger.warn(`Could not delete ${asset.storageKey}: ${String(error)}`);
    });
    await this.prisma.asset.delete({ where: { id: assetId } });
  }

  /** Writes a local file from a readable stream. Used for provider downloads. */
  async writeStreamToFile(stream: Readable, destinationPath: string): Promise<number> {
    await mkdir(dirname(destinationPath), { recursive: true });
    let sizeBytes = 0;
    const measure = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    await streamPipeline(stream, measure, createWriteStream(destinationPath));
    return sizeBytes;
  }

  private async record(
    input: StoreAssetInput,
    storageKey: string,
    sizeBytes: number,
    checksum: string | null,
  ) {
    return this.prisma.asset.create({
      data: {
        videoId: input.videoId,
        kind: input.kind,
        storageKey,
        contentType: input.contentType,
        sizeBytes,
        durationSeconds: input.durationSeconds ?? null,
        checksumSha256: checksum,
        sourceProvider: input.sourceProvider,
        sourceModel: input.sourceModel ?? null,
        sourceReference: input.sourceReference ?? null,
        licenseStatus: input.licenseStatus,
        licenseNote: input.licenseNote ?? null,
        licenseUrl: input.licenseUrl ?? null,
      },
    });
  }

  /** `videos/<id>/<kind>/<filename>`, or `shared/...` for unattached assets. */
  private buildKey(input: StoreAssetInput, filename: string): string {
    const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
    const scope = input.videoId ? `videos/${input.videoId}` : 'shared';
    return `${scope}/${input.kind.toLowerCase()}/${Date.now()}-${safeName}`;
  }

  /** Provenance travels with the object, not only in our database. */
  private provenanceMetadata(input: StoreAssetInput): Record<string, string> {
    return {
      kind: input.kind,
      sourceProvider: input.sourceProvider,
      licenseStatus: input.licenseStatus,
      ...(input.sourceModel ? { sourceModel: input.sourceModel } : {}),
      ...(input.videoId ? { videoId: input.videoId } : {}),
    };
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
