import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Readable } from 'node:stream';
import { AppConfig } from '@/config/app-config';
import { envSchema } from '@/config/env.schema';
import { parseByteRange } from '@/common/utils/http-range';
import { LocalStorageProvider } from '@/providers/storage/local-storage.provider';

/**
 * HTTP byte ranges for media previews.
 *
 * Found when the operator could not play any video in the dashboard on Safari: the
 * asset route ignored `Range`, and the dashboard proxy dropped the header anyway.
 * Safari probes with `bytes=0-1` and shows a crossed-out play button unless it gets a
 * 206 back. Chrome tolerates a plain 200, which is why it played in testing.
 */

describe('parseByteRange', () => {
  const size = 1000;

  it('sends everything when there is no header', () => {
    expect(parseByteRange(undefined, size)).toBeNull();
  });

  it("answers Safari's two-byte probe", () => {
    expect(parseByteRange('bytes=0-1', size)).toEqual({ start: 0, end: 1 });
  });

  it('serves an open-ended range to the end (seeking)', () => {
    expect(parseByteRange('bytes=500-', size)).toEqual({ start: 500, end: 999 });
  });

  it('serves a suffix range (the last N bytes)', () => {
    expect(parseByteRange('bytes=-100', size)).toEqual({ start: 900, end: 999 });
  });

  it('clamps an end past the object to its last byte', () => {
    expect(parseByteRange('bytes=900-5000', size)).toEqual({ start: 900, end: 999 });
  });

  it('clamps a suffix longer than the object to the whole object', () => {
    expect(parseByteRange('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
  });

  it('reports a start beyond the object as unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', size)).toBe('unsatisfiable');
  });

  it('reports any range on an empty object as unsatisfiable', () => {
    expect(parseByteRange('bytes=0-1', 0)).toBe('unsatisfiable');
  });

  it.each(['bytes=0-1,5-9', 'items=0-1', 'bytes=-', 'bytes=abc', 'bytes=9-3'])(
    'ignores %p and sends the whole object, as RFC 9110 allows',
    (header) => {
      expect(parseByteRange(header, size)).toBeNull();
    },
  );
});

describe('LocalStorageProvider ranged download', () => {
  let root: string;
  let storage: LocalStorageProvider;
  const content = Buffer.from('0123456789abcdefghij');

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'range-test-'));
    await mkdir(join(root, 'videos'), { recursive: true });
    await writeFile(join(root, 'videos', 'clip.mp4'), content);
    storage = new LocalStorageProvider(
      new AppConfig(
        envSchema.parse({
          DATABASE_URL: 'postgresql://test/test',
          SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
          ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
          INTERNAL_API_KEY: 'internal-key-for-tests',
          LOCAL_STORAGE_ROOT: root,
        }),
      ),
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function read(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString();
  }

  it('returns exactly the requested bytes, end inclusive', async () => {
    expect(await read(await storage.download('videos/clip.mp4', { start: 0, end: 1 }))).toBe('01');
    expect(await read(await storage.download('videos/clip.mp4', { start: 10, end: 19 }))).toBe(
      'abcdefghij',
    );
  });

  it('returns the whole object without a range', async () => {
    expect(await read(await storage.download('videos/clip.mp4'))).toBe(content.toString());
  });

  it('reports the size a Content-Range header needs', async () => {
    expect((await storage.stat('videos/clip.mp4'))?.sizeBytes).toBe(content.length);
  });
});
