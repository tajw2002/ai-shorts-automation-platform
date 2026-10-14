import { Injectable, Logger } from '@nestjs/common';
import {
  type BudgetDecision,
  type CostCategory,
  type CostEntry,
  type CostSummary,
  SystemSettingKey,
  usdToMicros,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { startOfDayInZone, startOfMonthInZone } from '@/common/utils/time';

/**
 * Cost tracking and enforcement.
 *
 * Two responsibilities, deliberately kept together because they must agree on
 * what "spent today" means:
 *   - `record()` writes one `CostRecord` per billable provider call.
 *   - `checkBudget()` is consulted *before* a call and refuses when the rolling
 *     daily or monthly budget is exhausted.
 *
 * Budget windows follow the configured timezone, not UTC, so "today" means what
 * the operator thinks it means.
 */
@Injectable()
export class CostService {
  private readonly logger = new Logger(CostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly settings: SystemSettingsService,
    private readonly systemLog: SystemLogService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Recording                                                              */
  /* ---------------------------------------------------------------------- */

  async record(
    entry: CostEntry & { videoId?: string | null; jobId?: string | null },
  ): Promise<void> {
    // Simulated means no money changed hands: a dry run, or a mock adapter in an
    // otherwise real setup (e.g. pictures mocked while text and voice are live).
    // Only the first case used to be caught, so mock clips filled the real budget.
    const simulated = this.config.safety.dryRun || entry.provider === MOCK_PROVIDER;

    await this.prisma.costRecord.create({
      data: {
        category: entry.category,
        provider: entry.provider,
        model: entry.model,
        operation: entry.operation,
        units: entry.units,
        unitLabel: entry.unitLabel,
        requests: entry.requests,
        estimatedMicros: Math.round(entry.estimatedMicros),
        actualMicros: entry.actualMicros === null ? null : Math.round(entry.actualMicros),
        videoId: entry.videoId ?? null,
        jobId: entry.jobId ?? null,
        simulated,
      },
    });

    // Keep the per-video roll-up current so the dashboard does not need to
    // aggregate on every page load. It shows money spent, so simulated cost stays out.
    if (entry.videoId && !simulated) {
      await this.prisma.video.update({
        where: { id: entry.videoId },
        data: {
          costMicros: { increment: Math.round(entry.actualMicros ?? entry.estimatedMicros) },
        },
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Enforcement                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Decides whether a call costing roughly `estimatedMicros` may proceed.
   *
   * Uses the *estimate* rather than waiting for the actual, because refusing
   * after the money is spent would be pointless.
   */
  async checkBudget(estimatedMicros: number): Promise<BudgetDecision> {
    const limits = await this.settings.getCostLimitsUsd();
    const dailyLimitMicros = usdToMicros(limits.daily);
    const monthlyLimitMicros = usdToMicros(limits.monthly);

    const { todayMicros, monthMicros } = await this.getSpend();

    const remainingDailyMicros = Math.max(0, dailyLimitMicros - todayMicros);
    const remainingMonthlyMicros = Math.max(0, monthlyLimitMicros - monthMicros);

    // A limit of zero means "no limit configured"; treating it as a hard block
    // would make an unset budget stop the platform.
    const dailyExceeded = dailyLimitMicros > 0 && todayMicros + estimatedMicros > dailyLimitMicros;
    const monthlyExceeded =
      monthlyLimitMicros > 0 && monthMicros + estimatedMicros > monthlyLimitMicros;

    if (dailyExceeded || monthlyExceeded) {
      const scope = dailyExceeded ? 'daily' : 'monthly';
      const reason =
        `The ${scope} cost limit would be exceeded by this operation ` +
        `(${scope} spend ${formatUsd(dailyExceeded ? todayMicros : monthMicros)} of ` +
        `${formatUsd(dailyExceeded ? dailyLimitMicros : monthlyLimitMicros)}).`;

      return {
        allowed: false,
        reason,
        warning: false,
        remainingDailyMicros,
        remainingMonthlyMicros,
      };
    }

    const threshold = this.config.cost.warnThreshold;
    const warning =
      (dailyLimitMicros > 0 && todayMicros >= dailyLimitMicros * threshold) ||
      (monthlyLimitMicros > 0 && monthMicros >= monthlyLimitMicros * threshold);

    return {
      allowed: true,
      reason: null,
      warning,
      remainingDailyMicros,
      remainingMonthlyMicros,
    };
  }

  /**
   * Enforces the budget and, when it is exhausted, halts generation.
   *
   * Hitting a limit has to stop all generation and raise an admin warning, not
   * just refuse the current call. Returning the decision
   * lets the caller produce a precise error.
   */
  async enforceBudget(estimatedMicros: number, operation: string): Promise<BudgetDecision> {
    const decision = await this.checkBudget(estimatedMicros);

    if (!decision.allowed) {
      await this.settings.set(SystemSettingKey.GENERATION_PAUSED, true);
      await this.systemLog.error(
        'CostService',
        `Generation halted: ${decision.reason} (blocked operation: ${operation})`,
      );
      this.logger.error(`Budget exhausted; generation paused. ${decision.reason}`);
    } else if (decision.warning) {
      await this.systemLog.warn(
        'CostService',
        `Spend has passed ${Math.round(this.config.cost.warnThreshold * 100)}% of a configured limit.`,
        { operation },
      );
    }

    return decision;
  }

  /* ---------------------------------------------------------------------- */
  /* Reporting                                                              */
  /* ---------------------------------------------------------------------- */

  async getSummary(): Promise<CostSummary> {
    const limits = await this.settings.getCostLimitsUsd();
    const { todayMicros, monthMicros } = await this.getSpend();

    const [videosGenerated, videosPublished, lifetimeMicros] = await Promise.all([
      this.prisma.video.count({ where: { status: { notIn: ['CREATED', 'FAILED', 'CANCELLED'] } } }),
      this.prisma.video.count({ where: { status: 'PUBLISHED' } }),
      // Per row, not per column: the old "actuals if any exist, else estimates"
      // dropped every provider that only reports estimates (Replicate) as soon as
      // one provider reported an actual.
      this.sumSpend({}),
    ]);

    return {
      todayMicros,
      monthMicros,
      dailyLimitMicros: usdToMicros(limits.daily),
      monthlyLimitMicros: usdToMicros(limits.monthly),
      costPerVideoMicros: videosGenerated > 0 ? Math.round(lifetimeMicros / videosGenerated) : 0,
      costPerPublishedVideoMicros:
        videosPublished > 0 ? Math.round(lifetimeMicros / videosPublished) : 0,
      videosGenerated,
      videosPublished,
    };
  }

  /** Spend by category over the trailing `days`, for the cost chart. */
  async getBreakdown(days = 30): Promise<Array<{ category: CostCategory; micros: number }>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const where = { ...REAL_SPEND, createdAt: { gte: since } };
    const [all, withActual] = await Promise.all([
      this.prisma.costRecord.groupBy({ by: ['category'], where, _sum: { estimatedMicros: true } }),
      this.prisma.costRecord.groupBy({
        by: ['category'],
        where: { ...where, actualMicros: { not: null } },
        _sum: { estimatedMicros: true, actualMicros: true },
      }),
    ]);

    // Same per-row rule as sumSpend: the actual where known, else the estimate.
    return all.map((row) => {
      const known = withActual.find((candidate) => candidate.category === row.category);
      return {
        category: row.category,
        micros: perRowTotal(
          row._sum.estimatedMicros,
          known?._sum.estimatedMicros,
          known?._sum.actualMicros,
        ),
      };
    });
  }

  /**
   * Current spend in the configured timezone.
   *
   * `actualMicros` is preferred where a provider reported one; otherwise the
   * estimate stands in. Summing both columns separately and picking per row is
   * not possible in a single aggregate, so the estimate total is corrected by the
   * difference on rows that have an actual.
   */
  private async getSpend(): Promise<{ todayMicros: number; monthMicros: number }> {
    const now = new Date();
    const timezone = this.config.app.timezone;
    const dayStart = startOfDayInZone(now, timezone);
    const monthStart = startOfMonthInZone(now, timezone);

    const [today, month] = await Promise.all([
      this.sumSpendSince(dayStart),
      this.sumSpendSince(monthStart),
    ]);

    return { todayMicros: today, monthMicros: month };
  }

  private async sumSpendSince(since: Date): Promise<number> {
    return this.sumSpend({ createdAt: { gte: since } });
  }

  /** Money actually spent: simulated rows excluded, actual preferred per row. */
  private async sumSpend(filter: { createdAt?: { gte: Date } }): Promise<number> {
    const where = { ...REAL_SPEND, ...filter };
    const [all, withActual] = await Promise.all([
      this.prisma.costRecord.aggregate({ where, _sum: { estimatedMicros: true } }),
      this.prisma.costRecord.aggregate({
        where: { ...where, actualMicros: { not: null } },
        _sum: { estimatedMicros: true, actualMicros: true },
      }),
    ]);
    return perRowTotal(
      all._sum.estimatedMicros,
      withActual._sum.estimatedMicros,
      withActual._sum.actualMicros,
    );
  }
}

/** Mock adapters all report this name; their calls cost nothing. */
const MOCK_PROVIDER = 'mock';

/** Rows that represent money spent. Budgets and reports count only these. */
const REAL_SPEND = { simulated: false } as const;

/**
 * Totals "actual where known, else estimate" per row from three column sums.
 *
 * A single aggregate cannot pick per row, so the estimate total is corrected by
 * swapping in the actual for the rows that have one.
 */
function perRowTotal(
  estimatedAll: number | null | undefined,
  estimatedWhereActualKnown: number | null | undefined,
  actual: number | null | undefined,
): number {
  return (estimatedAll ?? 0) - (estimatedWhereActualKnown ?? 0) + (actual ?? 0);
}

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
