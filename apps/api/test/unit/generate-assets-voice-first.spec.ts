import { AppConfig } from '@/config/app-config';
import { envSchema } from '@/config/env.schema';
import { GenerateAssetsStep } from '@/modules/pipeline/steps/generate-assets.step';
import { fitToDuration } from '@/modules/media/assembly.service';

/**
 * Voice first, then exactly as much picture as is spoken.
 *
 * The first real video ordered 38 s of clips for 23 s of narration. The render stops
 * with the voice, so about 40 % of the paid seconds were discarded, the closing scene
 * never appeared, and captions timed from the plan drifted behind the voice.
 *
 * The video provider here records each request and then fails it, which ends the step
 * before polling and download — the requests are what this test is about.
 */

const VOICEOVERS = [
  'Look, Leo! Your shadow is dancing on the wall.',
  'Ducky waddles over, flapping his wings into a funny shape.',
  'Now they take turns, giggling at every silly new animal.',
  'Hold hands, and watch — a big shadow heart glows warm between them.',
  'Sleepy eyes, soft yawns, the shadows settle down to dream.',
];
const PLANNED = [7, 7, 8, 8, 8];
const NARRATION_SECONDS = 22.83;

function makeConfig(): AppConfig {
  return new AppConfig(
    envSchema.parse({
      DATABASE_URL: 'postgresql://test/test',
      SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
      ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
      INTERNAL_API_KEY: 'internal-key-for-tests',
      VIDEO_CLIP_MIN_SECONDS: '4',
      VIDEO_CLIP_MAX_SECONDS: '12',
      MAX_CONCURRENT_GENERATIONS: '1',
    }),
  );
}

function harness(options: { alreadyOrdered?: boolean; existingVoiceSeconds?: number } = {}) {
  const events: string[] = [];
  const scenes = VOICEOVERS.map((voiceover, index) => ({
    id: `s${index}`,
    index,
    voiceover,
    prompt: `scene ${index}`,
    negativePrompt: null,
    seed: null,
    durationSeconds: PLANNED[index]!,
    assetId: null as string | null,
    providerJobId:
      options.alreadyOrdered && index === 0 ? 'pred_existing' : (null as string | null),
  }));
  const storedDurations = new Map<string, number>();

  const prisma = {
    video: { findUniqueOrThrow: jest.fn(async () => ({ id: 'v1', scenes })) },
    generationJob: {
      create: jest.fn(async () => ({ id: 'g1' })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    videoScene: {
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: { durationSeconds?: number } }) => {
          if (data.durationSeconds !== undefined)
            storedDurations.set(where.id, data.durationSeconds);
          return {};
        },
      ),
      findMany: jest.fn(async () => scenes.map((s) => ({ voiceover: s.voiceover }))),
    },
    sceneCharacter: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };

  const videoRequests: number[] = [];
  const video = {
    name: 'replicate',
    generateVideo: jest.fn(async (request: { durationSeconds: number }) => {
      events.push('video');
      videoRequests.push(request.durationSeconds);
      throw new Error('stop here: this test is about what was ordered');
    }),
  };
  const voice = {
    name: 'elevenlabs',
    generateSpeech: jest.fn(async () => {
      events.push('voice');
      return {
        data: { audio: Buffer.from('fake-mp3'), contentType: 'audio/mpeg', durationSeconds: null },
        model: 'eleven_multilingual_v2',
        usage: { units: 0, unitLabel: 'characters' },
      };
    }),
  };
  const assets = {
    findLatestForVideo: jest.fn(async () =>
      options.existingVoiceSeconds
        ? {
            storageKey: 'videos/v1/voiceover.mp3',
            contentType: 'audio/mpeg',
            durationSeconds: options.existingVoiceSeconds,
          }
        : null,
    ),
    storeBuffer: jest.fn(async () => ({ id: 'a1' })),
    downloadKeyToFile: jest.fn(async (_key: string, path: string) => path),
  };
  const metered = {
    run: jest.fn(async (_d: unknown, call: () => Promise<unknown>) => call()),
    runRaw: jest.fn(async (_d: unknown, call: () => Promise<unknown>) => call()),
  };
  const ffmpeg = { probe: jest.fn(async () => ({ durationSeconds: NARRATION_SECONDS })) };

  const step = new GenerateAssetsStep(
    prisma as never,
    makeConfig(),
    video as never,
    voice as never,
    assets as never,
    metered as never,
    { error: jest.fn(async () => undefined) } as never,
    ffmpeg as never,
  );
  return { step, events, videoRequests, storedDurations, assets, metered, voice };
}

const total = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

describe('GenerateAssetsStep: voice first', () => {
  it('records the narration before ordering a single clip', async () => {
    const h = harness();
    await expect(h.step.execute({ videoId: 'v1', jobId: 'j1' })).rejects.toThrow();
    expect(h.events[0]).toBe('voice');
    expect(h.events.filter((e) => e === 'voice')).toHaveLength(1);
  });

  it('re-times every scene so the plan sums to the measured narration', async () => {
    const h = harness();
    await expect(h.step.execute({ videoId: 'v1', jobId: 'j1' })).rejects.toThrow();
    const durations = [...h.storedDurations.values()];
    expect(durations).toHaveLength(5);
    expect(total(durations)).toBe(NARRATION_SECONDS);
  });

  it('orders whole-second clips within the model range, far below the 38 s plan', async () => {
    const h = harness();
    await expect(h.step.execute({ videoId: 'v1', jobId: 'j1' })).rejects.toThrow();
    expect(h.videoRequests).toHaveLength(5);
    for (const seconds of h.videoRequests) {
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThanOrEqual(4);
      expect(seconds).toBeLessThanOrEqual(12);
    }
    expect(total(h.videoRequests)).toBeLessThan(28);
    expect(total(h.videoRequests)).toBeGreaterThanOrEqual(NARRATION_SECONDS);
  });

  it('stores the measured length with the voiceover, not the provider value', async () => {
    const h = harness();
    await expect(h.step.execute({ videoId: 'v1', jobId: 'j1' })).rejects.toThrow();
    const [input] = h.assets.storeBuffer.mock.calls[0] as unknown as [{ durationSeconds: number }];
    expect(input.durationSeconds).toBe(NARRATION_SECONDS);
  });

  it('does not re-time once a clip has been ordered, and does not re-record the voice', async () => {
    const h = harness({ alreadyOrdered: true, existingVoiceSeconds: NARRATION_SECONDS });
    await expect(h.step.execute({ videoId: 'v1', jobId: 'j1' })).rejects.toThrow();
    expect(h.storedDurations.size).toBe(0);
    expect(h.voice.generateSpeech).not.toHaveBeenCalled();
  });

  it('reuses an existing voiceover on retry instead of paying for it again', async () => {
    const h = harness({ existingVoiceSeconds: NARRATION_SECONDS });
    await expect(h.step.execute({ videoId: 'v1', jobId: 'j1' })).rejects.toThrow();
    expect(h.voice.generateSpeech).not.toHaveBeenCalled();
    expect(total([...h.storedDurations.values()])).toBe(NARRATION_SECONDS);
  });
});

describe('fitToDuration', () => {
  it('cuts long clips and holds the last frame of short ones', () => {
    expect(fitToDuration(4.56)).toBe(
      'tpad=stop_mode=clone:stop_duration=4.560,trim=duration=4.560,setpts=PTS-STARTPTS',
    );
  });

  it.each([0, -1, Number.NaN])('leaves the clip untouched for %p', (seconds) => {
    expect(fitToDuration(seconds)).toBe('null');
  });
});
