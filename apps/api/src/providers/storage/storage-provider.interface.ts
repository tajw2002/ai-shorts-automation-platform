import { type Readable } from 'node:stream';
import { type ByteRange } from '@/common/utils/http-range';
import { type BaseProvider } from '../provider.types';

export interface StoredObject {
  key: string;
  sizeBytes: number;
  contentType: string;
  checksumSha256: string | null;
  /** Only set for providers that expose a stable public URL. */
  publicUrl: string | null;
}

export interface UploadOptions {
  contentType: string;
  /** Non-secret metadata attached to the object, e.g. provenance. */
  metadata?: Record<string, string>;
  /** Objects are private by default; this must be opted into explicitly. */
  publicRead?: boolean;
}

export interface StorageProvider extends BaseProvider {
  upload(key: string, body: Buffer | Readable, options: UploadOptions): Promise<StoredObject>;
  /**
   * Streams an object out, or only `range` of it (inclusive). Callers must
   * consume or destroy the stream.
   */
  download(key: string, range?: ByteRange): Promise<Readable>;
  /** Materialises an object on local disk — what ffmpeg needs. */
  downloadToFile(key: string, destinationPath: string): Promise<void>;
  /** Uploads straight from disk, so a 100 MB render never enters the heap. */
  uploadFromFile(key: string, sourcePath: string, options: UploadOptions): Promise<StoredObject>;
  exists(key: string): Promise<boolean>;
  stat(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /**
   * Time-limited read URL for the dashboard preview. Assets stay private; the
   * dashboard never gets a permanent public link.
   */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;
}
