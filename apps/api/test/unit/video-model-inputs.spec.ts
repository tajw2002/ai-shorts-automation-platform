import { envSchema } from '@/config/env.schema';
import { clampClipSeconds } from '@/common/utils/clip';
import { applyOverrides, toAspectRatio } from '@/providers/video/replicate-video.provider';

/**
 * Video-model input compatibility.
 *
 * Found by reading the real input schema of `bytedance/seedance-1-lite` before
 * spending anything. The adapter used to send `aspect_ratio: "1080:1920"` (the
 * model wants a label such as `"9:16"`), `fps: 30` (the model accepts only 24)
 * and any clip length (the model accepts 4-12 seconds). Each of those is rejected
 * at validation, so a real run would have failed on the very first scene.
 */

const baseEnv = {
  DATABASE_URL: 'postgresql://test/test',
  SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
  ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
  INTERNAL_API_KEY: 'internal-key-for-tests',
};

describe('toAspectRatio', () => {
  it.each([
    [1080, 1920, '9:16'],
    [720, 1280, '9:16'],
    [1920, 1080, '16:9'],
    [1080, 1080, '1:1'],
    [1080, 1440, '3:4'],
  ])('%ix%i -> %s', (width, height, expected) => {
    expect(toAspectRatio(width, height)).toBe(expected);
  });

  it('never returns raw pixel dimensions for the configured Shorts format', () => {
    expect(toAspectRatio(1080, 1920)).not.toContain('1080');
  });
});

describe('applyOverrides', () => {
  const common = () => ({ prompt: 'p', aspect_ratio: '9:16', duration: 8, fps: 30 });

  it('replaces a default with the model-specific value', () => {
    const input: Record<string, unknown> = common();
    applyOverrides(input, { fps: 24 });
    expect(input.fps).toBe(24);
  });

  it('adds inputs the adapter does not know about, such as resolution', () => {
    const input: Record<string, unknown> = common();
    applyOverrides(input, { resolution: '480p' });
    expect(input.resolution).toBe('480p');
  });

  it('removes a key when its override is null', () => {
    const input: Record<string, unknown> = common();
    applyOverrides(input, { fps: null });
    expect('fps' in input).toBe(false);
  });

  it('leaves everything else untouched', () => {
    const input: Record<string, unknown> = common();
    applyOverrides(input, { fps: 24 });
    expect(input).toEqual({ prompt: 'p', aspect_ratio: '9:16', duration: 8, fps: 24 });
  });

  it('is a no-op without overrides', () => {
    const input: Record<string, unknown> = common();
    applyOverrides(input, {});
    expect(input).toEqual(common());
  });
});

describe('clampClipSeconds', () => {
  it('raises a short scene to the model minimum', () => {
    expect(clampClipSeconds(3, 4, 12)).toBe(4);
  });

  it('lowers a long scene to the model maximum', () => {
    expect(clampClipSeconds(15, 4, 12)).toBe(12);
  });

  it('keeps a length that is already in range', () => {
    expect(clampClipSeconds(8, 4, 12)).toBe(8);
  });

  it('treats 0 as "no limit" on either side', () => {
    expect(clampClipSeconds(3, 0, 0)).toBe(3);
    expect(clampClipSeconds(60, 0, 0)).toBe(60);
    expect(clampClipSeconds(3, 0, 12)).toBe(3);
    expect(clampClipSeconds(30, 4, 0)).toBe(30);
  });
});

describe('video model settings', () => {
  it('defaults to no overrides and no clip limits', () => {
    const env = envSchema.parse(baseEnv);
    expect(env.VIDEO_INPUT_OVERRIDES).toEqual({});
    expect(env.VIDEO_CLIP_MIN_SECONDS).toBe(0);
    expect(env.VIDEO_CLIP_MAX_SECONDS).toBe(0);
  });

  it('parses a JSON object of overrides', () => {
    const env = envSchema.parse({
      ...baseEnv,
      VIDEO_INPUT_OVERRIDES: '{"fps":24,"resolution":"480p"}',
    });
    expect(env.VIDEO_INPUT_OVERRIDES).toEqual({ fps: 24, resolution: '480p' });
  });

  it.each(['{not json', '[1,2]', '"text"', '42', 'null'])(
    'rejects %p, naming the variable',
    (raw) => {
      const result = envSchema.safeParse({ ...baseEnv, VIDEO_INPUT_OVERRIDES: raw });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes('VIDEO_INPUT_OVERRIDES'))).toBe(
          true,
        );
      }
    },
  );

  it('rejects a minimum clip length above the maximum', () => {
    const result = envSchema.safeParse({
      ...baseEnv,
      VIDEO_CLIP_MIN_SECONDS: '12',
      VIDEO_CLIP_MAX_SECONDS: '4',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a coherent clip range', () => {
    const env = envSchema.parse({
      ...baseEnv,
      VIDEO_CLIP_MIN_SECONDS: '4',
      VIDEO_CLIP_MAX_SECONDS: '12',
    });
    expect([env.VIDEO_CLIP_MIN_SECONDS, env.VIDEO_CLIP_MAX_SECONDS]).toEqual([4, 12]);
  });
});
