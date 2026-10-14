import { AppConfig } from '@/config/app-config';
import { envSchema } from '@/config/env.schema';
import { ReplicateVideoProvider } from '@/providers/video/replicate-video.provider';

/**
 * Contract test: the adapter's real request against a real model's input limits.
 *
 * The limits below were read from the live input schema of
 * `bytedance/seedance-1-lite` on Replicate (`GET /v1/models/{owner}/{name}`), not
 * remembered. Nothing here calls the network; the point is that a request which the
 * model would reject at validation is caught by a test rather than by a billed run.
 */
const SEEDANCE_INPUT = {
  required: ['prompt'],
  aspect_ratio: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', '9:21'],
  fps: [24],
  resolution: ['480p', '720p', '1080p'],
  duration: { min: 4, max: 12 },
};

function violations(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of SEEDANCE_INPUT.required) {
    if (input[key] === undefined) found.push(`missing required input "${key}"`);
  }
  if (
    'aspect_ratio' in input &&
    !SEEDANCE_INPUT.aspect_ratio.includes(String(input.aspect_ratio))
  ) {
    found.push(`aspect_ratio "${String(input.aspect_ratio)}" is not one of the accepted labels`);
  }
  if ('fps' in input && !SEEDANCE_INPUT.fps.includes(Number(input.fps))) {
    found.push(
      `fps ${String(input.fps)} is not accepted (allowed: ${SEEDANCE_INPUT.fps.join(', ')})`,
    );
  }
  if ('resolution' in input && !SEEDANCE_INPUT.resolution.includes(String(input.resolution))) {
    found.push(`resolution "${String(input.resolution)}" is not accepted`);
  }
  const duration = Number(input.duration);
  if (
    'duration' in input &&
    (!Number.isInteger(duration) ||
      duration < SEEDANCE_INPUT.duration.min ||
      duration > SEEDANCE_INPUT.duration.max)
  ) {
    found.push(
      `duration ${String(input.duration)} is outside ${SEEDANCE_INPUT.duration.min}-${SEEDANCE_INPUT.duration.max}`,
    );
  }
  return found;
}

function makeProvider(extra: Record<string, string> = {}) {
  const config = new AppConfig(
    envSchema.parse({
      DATABASE_URL: 'postgresql://test/test',
      SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
      ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
      INTERNAL_API_KEY: 'internal-key-for-tests',
      VIDEO_PROVIDER: 'replicate',
      VIDEO_PROVIDER_API_KEY: 'r8_test_token_not_real',
      VIDEO_MODEL: 'bytedance/seedance-1-lite',
      ...extra,
    }),
  );
  const provider = new ReplicateVideoProvider(config);
  const request = jest.fn().mockResolvedValue({ data: { id: 'pred_1', status: 'starting' } });
  (provider as unknown as { http: { request: jest.Mock } }).http = { request };
  return { provider, request };
}

const SCENE = {
  prompt: 'A soft, sunlit nursery. Baby Leo giggles at a wobbly shadow bunny.',
  negativePrompt: null,
  width: 1080,
  height: 1920,
  fps: 30,
  seed: 7,
  reference: 'video:1',
};

async function sentInput(provider: ReplicateVideoProvider, request: jest.Mock, seconds: number) {
  await provider.generateVideo({ ...SCENE, durationSeconds: seconds });
  const [path, options] = request.mock.calls[0] as [
    string,
    { body: { input: Record<string, unknown> } },
  ];
  return { path, input: options.body.input };
}

describe('Replicate adapter against the seedance-1-lite input contract', () => {
  it('routes an official owner/name model through the models endpoint', async () => {
    const { provider, request } = makeProvider();
    const { path } = await sentInput(provider, request, 8);
    expect(path).toBe('/models/bytedance/seedance-1-lite/predictions');
  });

  it('sends the 9:16 label, not pixel dimensions', async () => {
    const { provider, request } = makeProvider();
    const { input } = await sentInput(provider, request, 8);
    expect(input.aspect_ratio).toBe('9:16');
  });

  it('documents why overrides are needed: fps 30 alone is rejected by this model', async () => {
    const { provider, request } = makeProvider();
    const { input } = await sentInput(provider, request, 8);
    expect(violations(input)).toEqual([expect.stringContaining('fps 30')]);
  });

  it('produces a valid request once the model-specific inputs are configured', async () => {
    const { provider, request } = makeProvider({
      VIDEO_INPUT_OVERRIDES: '{"fps":24,"resolution":"480p"}',
    });
    const { input } = await sentInput(provider, request, 8);
    expect(violations(input)).toEqual([]);
    expect(input).toMatchObject({ aspect_ratio: '9:16', fps: 24, resolution: '480p', duration: 8 });
  });

  it('rounds a fractional scene length to a whole second, as the model requires', async () => {
    const { provider, request } = makeProvider({
      VIDEO_INPUT_OVERRIDES: '{"fps":24}',
    });
    const { input } = await sentInput(provider, request, 7.6);
    expect(violations(input)).toEqual([]);
    expect(input.duration).toBe(8);
  });
});
