import { CostService } from '@/modules/cost/cost.service';
import { MeteredExecutor } from '@/modules/cost/metered-executor.service';
import { PublishGuardService } from '@/modules/youtube/publish-guard.service';
import { JobsService } from '@/modules/jobs/jobs.service';
import { AppConfig } from '@/config/app-config';
import { envSchema } from '@/config/env.schema';
import { BudgetExceededError } from '@/common/errors';
import {
  computeDerivedMetrics,
  computePerformanceScore,
  computeDelta,
} from '@/modules/analytics/metrics';
import { buildDailySeries } from '@/modules/analytics/analytics.service';
import { usdToMicros } from '@shorts/contracts';

/** A validated config with the safe defaults, plus any overrides a test needs. */
function makeConfig(overrides: Record<string, string> = {}): AppConfig {
  const parsed = envSchema.parse({
    DATABASE_URL: 'postgresql://test/test',
    SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
    ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    INTERNAL_API_KEY: 'internal-key-for-tests',
    ...overrides,
  });
  return new AppConfig(parsed);
}

describe('CostService.checkBudget', () => {
  function makeService(options: {
    todayMicros: number;
    monthMicros: number;
    dailyUsd?: number;
    monthlyUsd?: number;
  }) {
    const settings = {
      getCostLimitsUsd: jest.fn().mockResolvedValue({
        daily: options.dailyUsd ?? 10,
        monthly: options.monthlyUsd ?? 200,
      }),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const systemLog = { error: jest.fn(), warn: jest.fn() };

    const service = new CostService(
      {} as never,
      makeConfig(),
      settings as never,
      systemLog as never,
    );

    // Stand in for the two aggregate queries the real implementation runs.
    jest
      .spyOn(service as unknown as { getSpend: () => Promise<unknown> }, 'getSpend')
      .mockResolvedValue({
        todayMicros: options.todayMicros,
        monthMicros: options.monthMicros,
      });

    return { service, settings, systemLog };
  }

  it('allows a call comfortably inside budget', async () => {
    const { service } = makeService({ todayMicros: usdToMicros(1), monthMicros: usdToMicros(20) });
    const decision = await service.checkBudget(usdToMicros(0.5));

    expect(decision.allowed).toBe(true);
    expect(decision.warning).toBe(false);
    expect(decision.remainingDailyMicros).toBe(usdToMicros(9));
  });

  it('refuses a call that would cross the daily limit', async () => {
    const { service } = makeService({
      todayMicros: usdToMicros(9.8),
      monthMicros: usdToMicros(20),
    });
    const decision = await service.checkBudget(usdToMicros(0.5));

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/daily cost limit/i);
  });

  it('refuses a call that would cross the monthly limit', async () => {
    const { service } = makeService({ todayMicros: 0, monthMicros: usdToMicros(199.9) });
    const decision = await service.checkBudget(usdToMicros(1));

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/monthly cost limit/i);
  });

  it('warns once spend passes the configured threshold', async () => {
    const { service } = makeService({ todayMicros: usdToMicros(8.5), monthMicros: 0 });
    const decision = await service.checkBudget(usdToMicros(0.1));

    expect(decision.allowed).toBe(true);
    expect(decision.warning).toBe(true);
  });

  it('treats a limit of zero as "no limit", not as a total block', async () => {
    const { service } = makeService({
      todayMicros: usdToMicros(500),
      monthMicros: usdToMicros(500),
      dailyUsd: 0,
      monthlyUsd: 0,
    });
    await expect(service.checkBudget(usdToMicros(5))).resolves.toMatchObject({ allowed: true });
  });

  it('pauses generation and raises an alert when the budget is exhausted', async () => {
    const { service, settings, systemLog } = makeService({
      todayMicros: usdToMicros(10),
      monthMicros: usdToMicros(20),
    });

    const decision = await service.enforceBudget(usdToMicros(1), 'generateVideo');

    expect(decision.allowed).toBe(false);
    expect(settings.set).toHaveBeenCalledWith('GENERATION_PAUSED', true);
    expect(systemLog.error).toHaveBeenCalled();
  });
});

describe('MeteredExecutor', () => {
  function makeExecutor(allowed: boolean) {
    const cost = {
      enforceBudget: jest.fn().mockResolvedValue({
        allowed,
        reason: allowed ? null : 'Daily limit reached.',
        warning: false,
        remainingDailyMicros: 0,
        remainingMonthlyMicros: 0,
      }),
      record: jest.fn().mockResolvedValue(undefined),
    };
    return { executor: new MeteredExecutor(cost as never), cost };
  }

  const descriptor = {
    category: 'LLM' as const,
    provider: 'mock',
    operation: 'generateScript',
    estimatedMicros: 1000,
  };

  it('runs the call and records the actual cost', async () => {
    const { executor, cost } = makeExecutor(true);
    const call = jest.fn().mockResolvedValue({
      data: 'result',
      model: 'mock-v1',
      usage: { units: 500, unitLabel: 'tokens', actualCostMicros: 900 },
    });

    const result = await executor.run(descriptor, call);

    expect(result.data).toBe('result');
    expect(cost.record).toHaveBeenCalledWith(
      expect.objectContaining({ actualMicros: 900, estimatedMicros: 1000, model: 'mock-v1' }),
    );
  });

  it('refuses to make the call at all when over budget', async () => {
    const { executor } = makeExecutor(false);
    const call = jest.fn();

    await expect(executor.run(descriptor, call)).rejects.toBeInstanceOf(BudgetExceededError);
    // The important assertion: no money was spent.
    expect(call).not.toHaveBeenCalled();
  });

  it('checks the budget before the call, not after', async () => {
    const { executor, cost } = makeExecutor(true);
    const order: string[] = [];
    cost.enforceBudget.mockImplementation(async () => {
      order.push('budget');
      return {
        allowed: true,
        reason: null,
        warning: false,
        remainingDailyMicros: 0,
        remainingMonthlyMicros: 0,
      };
    });

    await executor.run(descriptor, async () => {
      order.push('call');
      return { data: null, model: 'm', usage: { units: 0, unitLabel: 'tokens' } };
    });

    expect(order).toEqual(['budget', 'call']);
  });

  it('records an estimate when the provider reports no actual cost', async () => {
    const { executor, cost } = makeExecutor(true);
    await executor.runRaw(
      { ...descriptor, fallbackUnits: 6, fallbackUnitLabel: 'seconds' },
      async () => 'handle',
    );

    expect(cost.record).toHaveBeenCalledWith(
      expect.objectContaining({ actualMicros: null, units: 6, unitLabel: 'seconds' }),
    );
  });
});

describe('PublishGuardService', () => {
  const APPROVED_VIDEO = {
    id: 'video-1',
    status: 'APPROVED',
    approvedAt: new Date(),
    title: 'A title',
    description: 'A description long enough to pass.',
    privacyStatus: 'private',
    safetyVerdict: 'ALLOW',
    channelId: 'channel-1',
    channel: { id: 'channel-1', isActive: true, madeForKids: false },
    assets: [{ kind: 'FINAL_VIDEO', licenseStatus: 'DERIVED_OWN' }],
    qualityReports: [{ passed: true, failureCount: 0, warningCount: 0 }],
  };

  function makeGuard(
    video: Record<string, unknown> | null,
    operational: Partial<Record<string, boolean>> = {},
    quotaCounts = { today: 0, month: 0 },
  ) {
    const prisma = {
      video: { findUnique: jest.fn().mockResolvedValue(video) },
      uploadJob: {
        count: jest
          .fn()
          .mockResolvedValueOnce(quotaCounts.today)
          .mockResolvedValueOnce(quotaCounts.month),
      },
    };
    const settings = {
      getOperationalState: jest.fn().mockResolvedValue({
        emergencyStop: false,
        generationPaused: false,
        uploadsPaused: false,
        autoPublish: false,
        requireApproval: true,
        dryRun: true,
        haltReason: null,
        ...operational,
      }),
      getUploadQuotas: jest.fn().mockResolvedValue({ daily: 3, monthly: 60 }),
      getDefaultPrivacyStatus: jest.fn().mockResolvedValue('private'),
    };

    return new PublishGuardService(prisma as never, makeConfig(), settings as never);
  }

  it('allows a fully prepared video', async () => {
    const decision = await makeGuard(APPROVED_VIDEO).evaluate('video-1');
    expect(decision.blockers).toEqual([]);
    expect(decision.allowed).toBe(true);
  });

  it('blocks while the emergency stop is active', async () => {
    const decision = await makeGuard(APPROVED_VIDEO, { emergencyStop: true }).evaluate('video-1');
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toContain('Emergency stop is active.');
  });

  it('blocks while uploads are paused', async () => {
    const decision = await makeGuard(APPROVED_VIDEO, { uploadsPaused: true }).evaluate('video-1');
    expect(decision.blockers).toContain('Uploads are paused by an operator.');
  });

  it('blocks a video that has not been approved by a person', async () => {
    const decision = await makeGuard({ ...APPROVED_VIDEO, approvedAt: null }).evaluate('video-1');
    expect(decision.blockers.join(' ')).toMatch(/not been approved/i);
  });

  it('blocks a video that is not in an approved state', async () => {
    const decision = await makeGuard({
      ...APPROVED_VIDEO,
      status: 'READY_FOR_REVIEW',
    }).evaluate('video-1');
    expect(decision.blockers.join(' ')).toMatch(/only an APPROVED video/i);
  });

  it('blocks when quality control has not run or did not pass', async () => {
    const noReport = await makeGuard({ ...APPROVED_VIDEO, qualityReports: [] }).evaluate('video-1');
    expect(noReport.blockers.join(' ')).toMatch(/not passed quality control/i);

    const failed = await makeGuard({
      ...APPROVED_VIDEO,
      qualityReports: [{ passed: false, failureCount: 2, warningCount: 0 }],
    }).evaluate('video-1');
    expect(failed.blockers.join(' ')).toMatch(/Quality control failed/i);
  });

  it('blocks a safety-blocked video', async () => {
    const decision = await makeGuard({ ...APPROVED_VIDEO, safetyVerdict: 'BLOCK' }).evaluate(
      'video-1',
    );
    expect(decision.blockers.join(' ')).toMatch(/safety layer blocked/i);
  });

  it('blocks when any asset has unestablished provenance', async () => {
    const decision = await makeGuard({
      ...APPROVED_VIDEO,
      assets: [
        { kind: 'FINAL_VIDEO', licenseStatus: 'DERIVED_OWN' },
        { kind: 'MUSIC', licenseStatus: 'UNKNOWN' },
      ],
    }).evaluate('video-1');
    expect(decision.blockers.join(' ')).toMatch(/unestablished provenance/i);
  });

  it('blocks when there is no rendered file', async () => {
    const decision = await makeGuard({ ...APPROVED_VIDEO, assets: [] }).evaluate('video-1');
    expect(decision.blockers.join(' ')).toMatch(/no rendered video file/i);
  });

  it('blocks once the daily upload quota is spent', async () => {
    const decision = await makeGuard(APPROVED_VIDEO, {}, { today: 3, month: 10 }).evaluate(
      'video-1',
    );
    expect(decision.blockers.join(' ')).toMatch(/daily upload limit/i);
  });

  it('downgrades a public request to private when auto-publish is off', async () => {
    const decision = await makeGuard({
      ...APPROVED_VIDEO,
      privacyStatus: 'public',
    }).evaluate('video-1');

    expect(decision.effectivePrivacyStatus).toBe('private');
    expect(decision.warnings.join(' ')).toMatch(/uploaded as private/i);
  });

  it('honours a public request when auto-publish is on', async () => {
    const decision = await makeGuard(
      { ...APPROVED_VIDEO, privacyStatus: 'public' },
      { autoPublish: true },
    ).evaluate('video-1');

    expect(decision.effectivePrivacyStatus).toBe('public');
  });

  it('reports every blocker at once rather than the first', async () => {
    const decision = await makeGuard(
      { ...APPROVED_VIDEO, status: 'CREATED', approvedAt: null, title: '', assets: [] },
      { emergencyStop: true },
    ).evaluate('video-1');

    expect(decision.blockers.length).toBeGreaterThanOrEqual(4);
  });

  it('handles a video that no longer exists', async () => {
    const decision = await makeGuard(null).evaluate('missing');
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toContain('The video no longer exists.');
  });
});

describe('JobsService idempotency and backoff', () => {
  function makeService(existingJob: Record<string, unknown> | null) {
    const prisma = {
      job: {
        findUnique: jest.fn().mockResolvedValue(existingJob),
        create: jest.fn().mockResolvedValue({ id: 'job-new' }),
        update: jest.fn().mockResolvedValue({ id: 'job-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const queue = { enqueue: jest.fn().mockResolvedValue(undefined), cancel: jest.fn() };
    return {
      service: new JobsService(prisma as never, makeConfig(), queue as never),
      prisma,
      queue,
    };
  }

  it('does not create a second job for work already pending', async () => {
    const { service, prisma } = makeService({ id: 'job-1', status: 'QUEUED' });
    const id = await service.enqueue({ type: 'PIPELINE_ADVANCE', videoId: 'v1' });

    expect(id).toBe('job-1');
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it('creates a job when none exists', async () => {
    const { service, prisma, queue } = makeService(null);
    const id = await service.enqueue({ type: 'PIPELINE_ADVANCE', videoId: 'v1' });

    expect(id).toBe('job-new');
    expect(prisma.job.create).toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalled();
  });

  it('revives a finished job so an explicit re-run can proceed', async () => {
    const { service, prisma } = makeService({ id: 'job-1', status: 'SUCCEEDED' });
    await service.enqueue({ type: 'PIPELINE_ADVANCE', videoId: 'v1' });

    expect(prisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'QUEUED', attempts: 0 }) }),
    );
  });

  it('keeps the durable row even when the queue backend fails', async () => {
    const { service, prisma, queue } = makeService(null);
    queue.enqueue.mockRejectedValue(new Error('queue unavailable'));

    // The job must still be created; the poller is the safety net.
    await expect(service.enqueue({ type: 'UPLOAD', videoId: 'v1' })).resolves.toBe('job-new');
    expect(prisma.job.create).toHaveBeenCalled();
  });

  it('derives the same idempotency key for the same unit of work', async () => {
    const { service, queue } = makeService(null);
    await service.enqueue({ type: 'PIPELINE_ADVANCE', videoId: 'v1' });
    const first = queue.enqueue.mock.calls[0]?.[0]?.idempotencyKey;

    queue.enqueue.mockClear();
    await service.enqueue({ type: 'PIPELINE_ADVANCE', videoId: 'v1' });
    const second = queue.enqueue.mock.calls[0]?.[0]?.idempotencyKey;

    expect(first).toBe(second);
  });
});

describe('analytics metrics', () => {
  const publishedAt = new Date('2026-01-01T00:00:00Z');

  it('computes rates from a snapshot', () => {
    const metrics = computeDerivedMetrics(
      { views: 1000, likes: 50, comments: 10, capturedAt: new Date() },
      publishedAt,
      new Date('2026-01-02T00:00:00Z'),
    );

    expect(metrics.hoursSincePublish).toBe(24);
    expect(metrics.viewsPerHour).toBeCloseTo(41.67, 1);
    expect(metrics.likeRate).toBeCloseTo(0.05);
    expect(metrics.commentRate).toBeCloseTo(0.01);
  });

  it('does not divide by zero for a brand-new video', () => {
    const metrics = computeDerivedMetrics(
      { views: 5, likes: 0, comments: 0, capturedAt: new Date() },
      new Date(),
      new Date(),
    );
    expect(Number.isFinite(metrics.viewsPerHour)).toBe(true);
    expect(metrics.hoursSincePublish).toBe(0.5);
  });

  it('treats zero views as zero engagement rather than NaN', () => {
    const metrics = computeDerivedMetrics(
      { views: 0, likes: 0, comments: 0, capturedAt: new Date() },
      publishedAt,
      new Date('2026-01-02T00:00:00Z'),
    );
    expect(metrics.likeRate).toBe(0);
    expect(metrics.commentRate).toBe(0);
  });

  it('damps the score of a video too young to judge', () => {
    const young = computePerformanceScore({
      viewsPerHour: 100,
      likeRate: 0.05,
      commentRate: 0.01,
      hoursSincePublish: 1,
    });
    const mature = computePerformanceScore({
      viewsPerHour: 100,
      likeRate: 0.05,
      commentRate: 0.01,
      hoursSincePublish: 48,
    });
    expect(young).toBeLessThan(mature);
  });

  it('keeps the score inside 0-100', () => {
    const extreme = computePerformanceScore({
      viewsPerHour: 1_000_000,
      likeRate: 1,
      commentRate: 1,
      hoursSincePublish: 1000,
    });
    expect(extreme).toBeLessThanOrEqual(100);
    expect(extreme).toBeGreaterThanOrEqual(0);
  });

  it('caps engagement so a 3-view video cannot look like a hit', () => {
    const tiny = computePerformanceScore({
      viewsPerHour: 0.1,
      likeRate: 1,
      commentRate: 1,
      hoursSincePublish: 48,
    });
    const real = computePerformanceScore({
      viewsPerHour: 500,
      likeRate: 0.04,
      commentRate: 0.005,
      hoursSincePublish: 48,
    });
    expect(tiny).toBeLessThan(real);
  });

  it('never reports negative growth when YouTube revises counts down', () => {
    const delta = computeDelta(
      { views: 1000, likes: 50, comments: 10, capturedAt: new Date('2026-01-01T00:00:00Z') },
      { views: 950, likes: 48, comments: 10, capturedAt: new Date('2026-01-01T06:00:00Z') },
    );
    expect(delta.views).toBe(0);
    expect(delta.likes).toBe(0);
    expect(delta.hours).toBe(6);
  });
});

describe('buildDailySeries', () => {
  it('uses each video’s latest reading per day, not the sum of all readings', () => {
    const series = buildDailySeries([
      {
        capturedAt: new Date('2026-01-01T06:00:00Z'),
        views: 100,
        likes: 1,
        comments: 0,
        videoId: 'a',
      },
      {
        capturedAt: new Date('2026-01-01T18:00:00Z'),
        views: 180,
        likes: 3,
        comments: 1,
        videoId: 'a',
      },
      {
        capturedAt: new Date('2026-01-01T18:00:00Z'),
        views: 20,
        likes: 0,
        comments: 0,
        videoId: 'b',
      },
    ]);

    expect(series).toHaveLength(1);
    // 180 (a's latest) + 20 (b) — not 100 + 180 + 20.
    expect(series[0]).toMatchObject({ date: '2026-01-01', views: 200, likes: 3 });
  });

  it('returns days in chronological order', () => {
    const series = buildDailySeries([
      {
        capturedAt: new Date('2026-01-03T00:00:00Z'),
        views: 3,
        likes: 0,
        comments: 0,
        videoId: 'a',
      },
      {
        capturedAt: new Date('2026-01-01T00:00:00Z'),
        views: 1,
        likes: 0,
        comments: 0,
        videoId: 'a',
      },
    ]);
    expect(series.map((point) => point.date)).toEqual(['2026-01-01', '2026-01-03']);
  });

  it('handles an empty input', () => {
    expect(buildDailySeries([])).toEqual([]);
  });
});
