import { Injectable, Logger } from '@nestjs/common';
import { JobType } from '@shorts/contracts';
import { JobsService, type ClaimedJob } from '@/modules/jobs/jobs.service';
import { PipelineOrchestrator } from '@/modules/pipeline/pipeline.orchestrator';
import { PublishingService } from '@/modules/youtube/publishing.service';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { PerformanceAnalysisService } from '@/modules/analytics/performance-analysis.service';
import { IdeasService } from '@/modules/content/ideas.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { describeError, ValidationError } from '@/common/errors';

/**
 * Dispatches a claimed job to the code that does the work.
 *
 * The runner owns the *outcome* bookkeeping — success, retry, dead letter — so no
 * handler has to remember to record it. Handlers just do their job and throw on
 * failure; `JobsService.markFailed` decides whether that failure is worth
 * retrying and applies the backoff.
 */
@Injectable()
export class JobRunnerService {
  private readonly logger = new Logger(JobRunnerService.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly pipeline: PipelineOrchestrator,
    private readonly publishing: PublishingService,
    private readonly analytics: AnalyticsService,
    private readonly performance: PerformanceAnalysisService,
    private readonly ideas: IdeasService,
    private readonly systemLog: SystemLogService,
  ) {}

  /**
   * Claims a specific job and runs it.
   *
   * Returns `skipped` when the claim failed — another worker already has it, or
   * it is no longer runnable. That is a normal outcome under at-least-once
   * delivery, not an error.
   */
  async runJob(jobId: string): Promise<{ status: 'completed' | 'failed' | 'skipped' }> {
    const job = await this.jobs.claimById(jobId);
    if (!job) return { status: 'skipped' };
    return this.execute(job);
  }

  /** Claims whatever is due next. Used by the in-process poller. */
  async runNext(): Promise<{ status: 'completed' | 'failed' | 'skipped' | 'idle' }> {
    const job = await this.jobs.claimNext();
    if (!job) return { status: 'idle' };
    return this.execute(job);
  }

  private async execute(job: ClaimedJob): Promise<{ status: 'completed' | 'failed' }> {
    const startedAt = Date.now();
    this.logger.log(
      `Running job ${job.id} (${job.type}), attempt ${job.attempts}/${job.maxAttempts}.`,
    );

    try {
      await this.dispatch(job);
      await this.jobs.markSucceeded(job.id);
      this.logger.log(`Job ${job.id} (${job.type}) completed in ${Date.now() - startedAt}ms.`);
      return { status: 'completed' };
    } catch (error) {
      const outcome = await this.jobs.markFailed(job.id, error);
      await this.systemLog.error(
        'JobRunner',
        `Job ${job.type} ${outcome.willRetry ? 'failed and will retry' : 'failed permanently'}.`,
        error,
        { jobId: job.id, videoId: job.videoId },
      );
      return { status: 'failed' };
    }
  }

  private async dispatch(job: ClaimedJob): Promise<void> {
    switch (job.type) {
      case JobType.PIPELINE_ADVANCE: {
        const videoId = this.requireVideoId(job);
        await this.pipeline.advance(videoId, job.id);
        return;
      }

      case JobType.UPLOAD: {
        const uploadJobId = readString(job.payload, 'uploadJobId');
        if (!uploadJobId) {
          throw new ValidationError('An UPLOAD job requires an uploadJobId in its payload.');
        }
        await this.publishing.execute(uploadJobId);
        return;
      }

      case JobType.ANALYTICS_SYNC: {
        // With a video id, refresh just that one; without, sweep every channel.
        if (job.videoId) {
          await this.analytics.syncVideo(job.videoId);
        } else {
          await this.analytics.syncAll();
        }
        return;
      }

      case JobType.PERFORMANCE_ANALYSIS:
        await this.performance.analyze();
        return;

      case JobType.IDEA_GENERATION: {
        const count = readNumber(job.payload, 'count') ?? 1;
        await this.ideas.generate({ count, usePerformanceInsights: true });
        return;
      }

      // These stages are driven through PIPELINE_ADVANCE rather than as separate
      // job types; the enum values exist so a future split does not need a
      // migration, and so the dashboard can label historical rows.
      case JobType.SCRIPT_GENERATION:
      case JobType.SCENE_PLANNING:
      case JobType.VIDEO_GENERATION:
      case JobType.VOICE_GENERATION:
      case JobType.ASSEMBLY:
      case JobType.QUALITY_CONTROL:
      case JobType.METADATA_GENERATION: {
        const videoId = this.requireVideoId(job);
        await this.pipeline.advance(videoId, job.id);
        return;
      }

      default: {
        // Exhaustiveness: adding a JobType without a branch fails to compile.
        const unreachable: never = job.type;
        throw new ValidationError(
          `No handler is registered for job type '${String(unreachable)}'.`,
        );
      }
    }
  }

  private requireVideoId(job: ClaimedJob): string {
    const videoId = job.videoId ?? readString(job.payload, 'videoId');
    if (!videoId) {
      throw new ValidationError(`Job ${job.id} (${job.type}) has no video to act on.`);
    }
    return videoId;
  }
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export { describeError };
