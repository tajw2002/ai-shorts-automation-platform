import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppConfig } from '@/config/app-config';
import { SchedulerService } from '@/modules/scheduler/scheduler.service';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { JobsService } from '@/modules/jobs/jobs.service';
import { AuthService } from '@/modules/auth/auth.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { describeError } from '@/common/errors';

/**
 * In-process cron for local development and single-instance deployments.
 *
 * On Cloud Run these same operations are driven by Cloud Scheduler hitting
 * `/internal/cron/*`, because a scale-to-zero service has no process to run a
 * timer in — and several instances running the same timer would duplicate work.
 * The two are mutually exclusive: this service stands down unless the queue is
 * the in-process one.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly scheduler: SchedulerService,
    private readonly analytics: AnalyticsService,
    private readonly jobs: JobsService,
    private readonly auth: AuthService,
    private readonly systemLog: SystemLogService,
  ) {}

  /** True when this process should own the timers. */
  private get enabled(): boolean {
    if (this.config.app.isTest) return false;
    if (this.config.providers.queue !== 'inmemory') return false;
    return this.config.app.role === 'worker' || this.config.app.role === 'all';
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async runScheduler(): Promise<void> {
    if (!this.enabled) return;
    await this.guarded('scheduler', async () => {
      const result = await this.scheduler.tick();
      if (result.published > 0 || result.started > 0) {
        this.logger.log(
          `Scheduler: ${result.published} queued for publication, ${result.started} started.`,
        );
      }
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async syncAnalytics(): Promise<void> {
    if (!this.enabled || !this.config.analytics.syncEnabled) return;
    await this.guarded('analytics', async () => {
      const result = await this.analytics.syncAll();
      if (result.updated > 0) this.logger.log(`Analytics: refreshed ${result.updated} videos.`);
    });
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async requeueStaleJobs(): Promise<void> {
    if (!this.enabled) return;
    await this.guarded('stale-jobs', () => this.jobs.requeueStale());
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightlyMaintenance(): Promise<void> {
    if (!this.enabled) return;
    await this.guarded('prune-sessions', () => this.auth.pruneSessions());
    await this.guarded('prune-logs', () =>
      this.systemLog.prune(this.config.analytics.retentionDays),
    );
    await this.guarded('prune-snapshots', () => this.analytics.pruneSnapshots());
  }

  /**
   * A failing cron job must never take the process down or stop later runs, so
   * every task is wrapped rather than left to an unhandled rejection.
   */
  private async guarded(name: string, task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.logger.error(`Scheduled task '${name}' failed: ${describeError(error)}`);
      await this.systemLog
        .error('MaintenanceService', `Scheduled task '${name}' failed.`, error)
        .catch(() => undefined);
    }
  }
}
