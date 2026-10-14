import { VideoStatus as Status, type VideoStatus } from '@shorts/contracts';
import { PipelineOrchestrator } from '@/modules/pipeline/pipeline.orchestrator';
import { type PipelineStep } from '@/modules/pipeline/pipeline.types';
import { ProviderError } from '@/common/errors';

/**
 * Retry behaviour for steps that run in an in-progress status.
 *
 * Found by the first real (rather than mocked) video provider: two of five scenes
 * were rejected by Replicate with 402 and 429. Both are retryable, so the step left
 * the video in `GENERATING` for the job's own backoff to retry. But the retry looked
 * up a step for `GENERATING`, found none, returned in 3 ms, and the job reported
 * success. The video sat in `GENERATING` indefinitely with nothing running.
 *
 * Mock providers never fail, which is why nothing exercised this path before.
 */

interface Harness {
  orchestrator: PipelineOrchestrator;
  state: { status: VideoStatus; lastError: string | null };
  transitions: Array<[VideoStatus, VideoStatus]>;
  execute: jest.Mock;
}

function harness(options: {
  status: VideoStatus;
  attempts?: number;
  maxAttempts?: number;
  execute?: jest.Mock;
  jobIdKnown?: boolean;
}): Harness {
  const state = { status: options.status, lastError: null as string | null };
  const transitions: Array<[VideoStatus, VideoStatus]> = [];

  const prisma = {
    video: {
      findUnique: jest.fn(async () => ({
        id: 'v1',
        status: state.status,
        lockedAt: null,
        lockedBy: null,
      })),
      findUniqueOrThrow: jest.fn(async () => ({ status: state.status })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async ({ data }: { data: { status?: VideoStatus; lastError?: string } }) => {
        if (data.status) state.status = data.status;
        if (data.lastError !== undefined) state.lastError = data.lastError;
        return {};
      }),
    },
    videoStatusEvent: {
      create: jest.fn(async ({ data }: { data: { from: VideoStatus; to: VideoStatus } }) => {
        transitions.push([data.from, data.to]);
        return {};
      }),
    },
    job: {
      findUnique: jest.fn(async () => ({
        attempts: options.attempts ?? 1,
        maxAttempts: options.maxAttempts ?? 3,
      })),
    },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };

  const execute = options.execute ?? jest.fn(async () => ({ next: Status.GENERATED }));
  const step: PipelineStep = {
    name: 'generate-assets',
    from: Status.SCENES_PLANNED,
    running: Status.GENERATING,
    execute,
  } as PipelineStep;

  const orchestrator = new PipelineOrchestrator(
    prisma as never,
    { enqueue: jest.fn(async () => undefined) } as never,
    {
      getOperationalState: jest.fn(async () => ({ emergencyStop: false, generationPaused: false })),
    } as never,
    { error: jest.fn(async () => undefined) } as never,
    [step],
  );

  return { orchestrator, state, transitions, execute };
}

const transient = () =>
  new ProviderError({ provider: 'replicate', message: 'HTTP 429', retryable: true });

describe('PipelineOrchestrator: steps with an in-progress status', () => {
  it('moves a fresh video into the in-progress status before running the step', async () => {
    const h = harness({ status: Status.SCENES_PLANNED });

    await h.orchestrator.advance('v1', 'job1');

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.transitions[0]).toEqual([Status.SCENES_PLANNED, Status.GENERATING]);
    expect(h.state.status).toBe(Status.GENERATED);
  });

  it('resumes a video left in the in-progress status instead of doing nothing', async () => {
    const h = harness({ status: Status.GENERATING });

    const result = await h.orchestrator.advance('v1', 'job1');

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(result).toBe(Status.GENERATED);
  });

  it('does not record a pointless GENERATING -> GENERATING transition when resuming', async () => {
    const h = harness({ status: Status.GENERATING });

    await h.orchestrator.advance('v1', 'job1');

    expect(h.transitions).not.toContainEqual([Status.GENERATING, Status.GENERATING]);
    expect(h.transitions[0]).toEqual([Status.GENERATING, Status.GENERATED]);
  });

  it('keeps the video in progress after a retryable failure that still has retries left', async () => {
    const h = harness({
      status: Status.SCENES_PLANNED,
      attempts: 1,
      maxAttempts: 3,
      execute: jest.fn().mockRejectedValue(transient()),
    });

    await expect(h.orchestrator.advance('v1', 'job1')).rejects.toBeInstanceOf(ProviderError);

    expect(h.state.status).toBe(Status.GENERATING);
    expect(h.state.lastError).toContain('429');
  });

  it('fails the video when the final attempt fails, instead of leaving it in progress', async () => {
    const h = harness({
      status: Status.GENERATING,
      attempts: 3,
      maxAttempts: 3,
      execute: jest.fn().mockRejectedValue(transient()),
    });

    await expect(h.orchestrator.advance('v1', 'job1')).rejects.toBeInstanceOf(ProviderError);

    expect(h.state.status).toBe(Status.FAILED);
    expect(h.state.lastError).toContain('retries exhausted');
    expect(h.state.lastError).toContain('429');
  });

  it('fails the video immediately on a permanent error', async () => {
    const h = harness({
      status: Status.SCENES_PLANNED,
      attempts: 1,
      execute: jest
        .fn()
        .mockRejectedValue(
          new ProviderError({ provider: 'replicate', message: 'bad input', retryable: false }),
        ),
    });

    await expect(h.orchestrator.advance('v1', 'job1')).rejects.toBeInstanceOf(ProviderError);

    expect(h.state.status).toBe(Status.FAILED);
    expect(h.state.lastError).not.toContain('retries exhausted');
  });

  it('does not fail on a retryable error when the job is unknown', async () => {
    const h = harness({
      status: Status.SCENES_PLANNED,
      execute: jest.fn().mockRejectedValue(transient()),
    });

    await expect(h.orchestrator.advance('v1', null)).rejects.toBeInstanceOf(ProviderError);

    expect(h.state.status).toBe(Status.GENERATING);
  });
});

describe('PipelineOrchestrator construction', () => {
  const build = (steps: PipelineStep[]) =>
    new PipelineOrchestrator({} as never, {} as never, {} as never, {} as never, steps);

  it('rejects an in-progress status that another step already claims', () => {
    const a = { name: 'a', from: Status.CREATED, execute: jest.fn() } as unknown as PipelineStep;
    const b = {
      name: 'b',
      from: Status.SCENES_PLANNED,
      running: Status.CREATED,
      execute: jest.fn(),
    } as unknown as PipelineStep;

    expect(() => build([a, b])).toThrow(/runs in status CREATED/);
  });

  it('rejects two steps that share an in-progress status', () => {
    const a = {
      name: 'a',
      from: Status.SCENES_PLANNED,
      running: Status.GENERATING,
      execute: jest.fn(),
    } as unknown as PipelineStep;
    const b = {
      name: 'b',
      from: Status.GENERATED,
      running: Status.GENERATING,
      execute: jest.fn(),
    } as unknown as PipelineStep;

    expect(() => build([a, b])).toThrow(/already claims/);
  });
});
