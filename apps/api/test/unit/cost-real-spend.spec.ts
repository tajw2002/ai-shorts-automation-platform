import { AppConfig } from '@/config/app-config';
import { envSchema } from '@/config/env.schema';
import { CostService } from '@/modules/cost/cost.service';

/**
 * Budgets count money, not simulations.
 *
 * Found in a real session: pictures were mocked while text and voice ran live.
 * Outside DRY_RUN, mock bookings were stored as real spend, $2.41 of mock clips
 * filled the $3 daily budget, and generation paused although $0.15 had been spent.
 *
 * Two reporting bugs sat next to it: lifetime spend and the category breakdown
 * used "actuals if any exist, else estimates" per column, so a provider that only
 * reports estimates (Replicate) vanished from the totals once any actual existed.
 */

interface Row {
  category: string;
  provider: string;
  estimatedMicros: number;
  actualMicros: number | null;
  simulated: boolean;
  createdAt: Date;
  videoId: string | null;
}

type Where = {
  simulated?: boolean;
  createdAt?: { gte: Date };
  actualMicros?: { not: null };
};

/** Evaluates the subset of Prisma filters CostService uses. */
function matches(row: Row, where: Where = {}): boolean {
  if (where.simulated !== undefined && row.simulated !== where.simulated) return false;
  if (where.createdAt && row.createdAt < where.createdAt.gte) return false;
  if (where.actualMicros && row.actualMicros === null) return false;
  return true;
}

function sums(rows: Row[]) {
  return {
    estimatedMicros: rows.reduce((t, r) => t + r.estimatedMicros, 0),
    actualMicros: rows.some((r) => r.actualMicros !== null)
      ? rows.reduce((t, r) => t + (r.actualMicros ?? 0), 0)
      : null,
  };
}

function harness(options: { dryRun?: boolean; dailyLimit?: number } = {}) {
  const rows: Row[] = [];
  const videoCost = new Map<string, number>();
  const prisma = {
    costRecord: {
      create: jest.fn(async ({ data }: { data: Omit<Row, 'createdAt'> }) => {
        rows.push({ ...data, createdAt: new Date() });
        return {};
      }),
      aggregate: jest.fn(async ({ where }: { where?: Where }) => ({
        _sum: sums(rows.filter((r) => matches(r, where))),
      })),
      groupBy: jest.fn(async ({ where }: { where?: Where }) => {
        const selected = rows.filter((r) => matches(r, where));
        const categories = [...new Set(selected.map((r) => r.category))];
        return categories.map((category) => ({
          category,
          _sum: sums(selected.filter((r) => r.category === category)),
        }));
      }),
    },
    video: {
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { costMicros: { increment: number } };
        }) => {
          videoCost.set(where.id, (videoCost.get(where.id) ?? 0) + data.costMicros.increment);
          return {};
        },
      ),
      count: jest.fn(async () => 1),
    },
  };
  const settings = {
    getCostLimitsUsd: jest.fn(async () => ({ daily: options.dailyLimit ?? 3, monthly: 20 })),
    set: jest.fn(async () => undefined),
  };
  const config = new AppConfig(
    envSchema.parse({
      DATABASE_URL: 'postgresql://test/test',
      SESSION_SECRET: Buffer.alloc(32, 1).toString('base64'),
      ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
      INTERNAL_API_KEY: 'internal-key-for-tests',
      DRY_RUN: options.dryRun ? 'true' : 'false',
    }),
  );
  const service = new CostService(
    prisma as never,
    config,
    settings as never,
    { error: jest.fn(async () => undefined), warn: jest.fn(async () => undefined) } as never,
  );
  return { service, rows, videoCost, settings };
}

const usd = (dollars: number) => Math.round(dollars * 1_000_000);

function entry(provider: string, category: string, estimated: number, actual: number | null) {
  return {
    category: category as never,
    provider,
    model: null,
    operation: 'op',
    units: 1,
    unitLabel: 'units',
    requests: 1,
    estimatedMicros: usd(estimated),
    actualMicros: actual === null ? null : usd(actual),
    videoId: 'v1',
  };
}

describe('CostService: only real money counts', () => {
  it('flags a mock provider as simulated even outside DRY_RUN', async () => {
    const h = harness({ dryRun: false });
    await h.service.record(entry('mock', 'VIDEO', 1.04, null));
    await h.service.record(entry('replicate', 'VIDEO', 1.37, null));
    expect(h.rows.map((r) => [r.provider, r.simulated])).toEqual([
      ['mock', true],
      ['replicate', false],
    ]);
  });

  it('keeps simulated cost out of the per-video "spent" figure', async () => {
    const h = harness();
    await h.service.record(entry('mock', 'VIDEO', 1.04, null));
    await h.service.record(entry('anthropic', 'LLM', 0.05, 0.02));
    expect(h.videoCost.get('v1')).toBe(usd(0.02));
  });

  it('does not let mock bookings exhaust the budget (the real case)', async () => {
    const h = harness({ dailyLimit: 3 });
    await h.service.record(entry('mock', 'VIDEO', 2.41, null));
    await h.service.record(entry('anthropic', 'LLM', 0.4, 0.15));

    const decision = await h.service.checkBudget(usd(0.05));

    expect(decision.allowed).toBe(true);
    expect(h.settings.set).not.toHaveBeenCalled();
  });

  it('still stops real spend at the limit', async () => {
    const h = harness({ dailyLimit: 3 });
    await h.service.record(entry('replicate', 'VIDEO', 2.9, null));
    expect((await h.service.checkBudget(usd(0.2))).allowed).toBe(false);
  });

  it('treats everything in DRY_RUN as simulated, so a dry run never trips the budget', async () => {
    const h = harness({ dryRun: true, dailyLimit: 3 });
    await h.service.record(entry('anthropic', 'LLM', 5, 5));
    expect((await h.service.checkBudget(usd(0.05))).allowed).toBe(true);
  });

  it('reports lifetime spend per row, so estimate-only providers are not dropped', async () => {
    const h = harness();
    await h.service.record(entry('replicate', 'VIDEO', 1.37, null));
    await h.service.record(entry('anthropic', 'LLM', 0.06, 0.02));
    await h.service.record(entry('mock', 'VIDEO', 2.41, null));

    const summary = await h.service.getSummary();

    // 1.37 (estimate, no actual) + 0.02 (actual); the mock clip is excluded.
    expect(summary.costPerVideoMicros).toBe(usd(1.39));
    expect(summary.todayMicros).toBe(usd(1.39));
  });

  it('breaks spend down by category with the same per-row rule', async () => {
    const h = harness();
    await h.service.record(entry('replicate', 'VIDEO', 1.37, null));
    await h.service.record(entry('elevenlabs', 'VOICE', 0.17, 0.17));
    await h.service.record(entry('mock', 'VIDEO', 2.41, null));
    await h.service.record(entry('anthropic', 'LLM', 0.06, 0.02));

    const breakdown = await h.service.getBreakdown(30);
    const byCategory = Object.fromEntries(breakdown.map((b) => [b.category, b.micros]));

    expect(byCategory).toEqual({ VIDEO: usd(1.37), VOICE: usd(0.17), LLM: usd(0.02) });
  });
});
