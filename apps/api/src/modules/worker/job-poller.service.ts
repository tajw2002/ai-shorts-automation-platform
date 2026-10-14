import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '@/config/app-config';
import { JobsService } from '@/modules/jobs/jobs.service';
import { describeError } from '@/common/errors';
import { JobRunnerService } from './job-runner.service';

/**
 * Drains the job table in-process.
 *
 * Only active when `QUEUE_PROVIDER=inmemory` and this process has the worker
 * role. With Cloud Tasks the queue calls `/internal/tasks/run` instead and this
 * poller stays dormant — the two must never both run, or a job could be executed
 * twice concurrently (the claim would still make one of them a no-op, but the
 * wasted round trips are pointless).
 *
 * The loop is strictly sequential: one job at a time, and the next tick is only
 * scheduled after the previous finishes, so a slow job cannot cause overlapping
 * runs to pile up.
 */

const IDLE_INTERVAL_MS = 5_000;
/** When work was found, look again promptly rather than idling. */
const BUSY_INTERVAL_MS = 250;
/** How often to return jobs abandoned by a dead worker. */
const STALE_SWEEP_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class JobPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobPollerService.name);
  private timer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly config: AppConfig,
    private readonly runner: JobRunnerService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    if (!this.shouldRun()) {
      this.logger.log(
        `Job poller disabled (queue=${this.config.providers.queue}, role=${this.config.app.role}).`,
      );
      return;
    }

    this.logger.log('Job poller started; draining the database-backed queue in process.');
    this.scheduleNext(IDLE_INTERVAL_MS);

    this.staleTimer = setInterval(() => {
      void this.jobs.requeueStale().catch((error: unknown) => {
        this.logger.warn(`Stale-job sweep failed: ${describeError(error)}`);
      });
    }, STALE_SWEEP_INTERVAL_MS);
    this.staleTimer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.staleTimer) clearInterval(this.staleTimer);
  }

  private shouldRun(): boolean {
    // Tests drive the runner directly; a background timer would make them flaky.
    if (this.config.app.isTest) return false;
    if (this.config.providers.queue !== 'inmemory') return false;
    return this.config.app.role === 'worker' || this.config.app.role === 'all';
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      const result = await this.runner.runNext();
      // A completed job often unblocks the next one, so poll again immediately.
      this.scheduleNext(result.status === 'idle' ? IDLE_INTERVAL_MS : BUSY_INTERVAL_MS);
    } catch (error) {
      // The runner records job-level failures itself; reaching here means
      // something unexpected went wrong, so back off rather than spin.
      this.logger.error(`Job poller tick failed: ${describeError(error)}`);
      this.scheduleNext(IDLE_INTERVAL_MS);
    } finally {
      this.running = false;
    }
  }
}
