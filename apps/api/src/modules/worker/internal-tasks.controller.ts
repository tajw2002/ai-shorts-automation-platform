import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { taskEnvelopeSchema, type TaskEnvelope } from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { Internal } from '@/modules/auth/auth.guard';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { SchedulerService } from '@/modules/scheduler/scheduler.service';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { PerformanceAnalysisService } from '@/modules/analytics/performance-analysis.service';
import { JobsService } from '@/modules/jobs/jobs.service';
import { AuthService } from '@/modules/auth/auth.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { describeError } from '@/common/errors';
import { JobRunnerService } from './job-runner.service';

/**
 * Machine-to-machine endpoints.
 *
 * Cloud Tasks posts to `/internal/tasks/run`; Cloud Scheduler posts to the
 * `/internal/cron/*` routes. Both authenticate with an OIDC token minted for the
 * configured service account — verified by Cloud Run before the request arrives —
 * or, locally, with a shared secret. `@Internal()` makes that the only way in;
 * a user session is never sufficient.
 *
 * Excluded from the public API docs: these are infrastructure, not product surface.
 */
@ApiExcludeController()
@Controller('internal')
@Internal()
export class InternalTasksController {
  constructor(
    private readonly config: AppConfig,
    private readonly runner: JobRunnerService,
    private readonly scheduler: SchedulerService,
    private readonly analytics: AnalyticsService,
    private readonly performance: PerformanceAnalysisService,
    private readonly jobs: JobsService,
    private readonly auth: AuthService,
    private readonly systemLog: SystemLogService,
  ) {}

  /**
   * Executes one queued job.
   *
   * Always answers 200, even when the job fails: a non-2xx would make Cloud Tasks
   * redeliver, which would fight with the job's own retry policy and double the
   * backoff. Failures are recorded on the job row, which is the authority.
   */
  @Post('tasks/run')
  @HttpCode(200)
  async runTask(@Body(zodBody(taskEnvelopeSchema)) envelope: TaskEnvelope) {
    const result = await this.runner.runJob(envelope.jobId);
    return { jobId: envelope.jobId, type: envelope.type, ...result };
  }

  /** Cloud Scheduler → evaluates every publishing schedule. */
  @Post('cron/scheduler')
  @HttpCode(200)
  async cronScheduler() {
    const result = await this.scheduler.tick();
    return { ok: true, ...result };
  }

  /** Cloud Scheduler → refreshes analytics for published videos. */
  @Post('cron/analytics')
  @HttpCode(200)
  async cronAnalytics() {
    const result = await this.analytics.syncAll();
    return { ok: true, ...result };
  }

  /** Cloud Scheduler → re-derives performance insights. */
  @Post('cron/performance-analysis')
  @HttpCode(200)
  async cronPerformance() {
    const result = await this.performance.analyze();
    return {
      ok: true,
      insights: result?.insights.length ?? 0,
      sampleSize: result?.sampleSize ?? 0,
    };
  }

  /**
   * Cloud Scheduler → housekeeping.
   *
   * Each task is independent, so one failing must not prevent the others; the
   * outcome of every task is reported rather than the first error thrown.
   */
  @Post('cron/maintenance')
  @HttpCode(200)
  async cronMaintenance() {
    const outcomes: Record<string, number | string> = {};

    const run = async (name: string, task: () => Promise<number>): Promise<void> => {
      try {
        outcomes[name] = await task();
      } catch (error) {
        outcomes[name] = `failed: ${describeError(error)}`;
        await this.systemLog.error('Maintenance', `Task ${name} failed.`, error);
      }
    };

    await run('staleJobsRequeued', () => this.jobs.requeueStale());
    await run('sessionsPruned', () => this.auth.pruneSessions());
    await run('logsPruned', () => this.systemLog.prune(this.config.analytics.retentionDays));
    await run('snapshotsPruned', () => this.analytics.pruneSnapshots());

    return { ok: true, ...outcomes };
  }

  /**
   * In-process drain, for the local `all` role when something needs a nudge.
   * Bounded so a call cannot run indefinitely.
   */
  @Post('tasks/drain')
  @HttpCode(200)
  async drain(@Body() body: { max?: number }) {
    const max = Math.min(Math.max(1, body?.max ?? 10), 50);
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < max; i += 1) {
      const result = await this.runner.runNext();
      if (result.status === 'idle') break;
      if (result.status === 'completed') completed += 1;
      if (result.status === 'failed') failed += 1;
    }

    return { ok: true, completed, failed };
  }
}
