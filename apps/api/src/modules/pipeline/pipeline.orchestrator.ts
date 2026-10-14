import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  JobType,
  TERMINAL_VIDEO_STATUSES,
  type VideoStatus,
  VideoStatus as Status,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { JobsService } from '@/modules/jobs/jobs.service';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import {
  AppError,
  ConflictError,
  describeError,
  InvalidStateTransitionError,
  NotFoundError,
  SystemHaltedError,
} from '@/common/errors';
import { PIPELINE_STEPS, type PipelineStep } from './pipeline.types';

/**
 * The video state machine.
 *
 * This is the only place `Video.status` is mutated by the system. Centralising it
 * buys three things:
 *
 *  - **A single guard point.** Emergency stop, generation pause and status
 *    validity are checked once, not in every step.
 *  - **A real audit trail.** Every transition writes a `VideoStatusEvent`, so a
 *    video's history is reconstructable rather than inferred from timestamps.
 *  - **Safe concurrency.** A lock column claimed with a conditional UPDATE means
 *    two workers handed the same video cannot both run a step.
 */

/** A lock older than this belonged to a worker that died; it may be broken. */
const LOCK_TIMEOUT_MS = 30 * 60_000;

@Injectable()
export class PipelineOrchestrator {
  private readonly logger = new Logger(PipelineOrchestrator.name);
  private readonly steps: Map<VideoStatus, PipelineStep>;
  /**
   * Steps that park a video in an in-progress status (`GENERATING`, `ASSEMBLING`)
   * while they run, keyed by that status.
   *
   * A retryable failure deliberately leaves the video there so the retry can pick
   * up where the step stopped. Without this map the retry finds no step for that
   * status, returns immediately, and the job reports success while the video
   * stays in progress forever.
   */
  private readonly resumable: Map<VideoStatus, PipelineStep>;
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly settings: SystemSettingsService,
    private readonly systemLog: SystemLogService,
    @Inject(PIPELINE_STEPS) steps: PipelineStep[],
  ) {
    this.steps = new Map();
    for (const step of steps) {
      if (this.steps.has(step.from)) {
        // Two steps claiming one status would make the pipeline non-deterministic.
        throw new Error(
          `Two pipeline steps claim status ${step.from}: ` +
            `${this.steps.get(step.from)?.name} and ${step.name}.`,
        );
      }
      this.steps.set(step.from, step);
    }

    this.resumable = new Map();
    for (const step of steps) {
      if (!step.running) continue;
      const clash = this.steps.get(step.running) ?? this.resumable.get(step.running);
      if (clash) {
        // Resuming by status only works if the status identifies exactly one step.
        throw new Error(
          `Pipeline step ${step.name} runs in status ${step.running}, ` +
            `which ${clash.name} already claims.`,
        );
      }
      this.resumable.set(step.running, step);
    }
  }

  /**
   * Runs the step registered for the video's current status.
   *
   * Advances by exactly one transition and enqueues a follow-up job rather than
   * looping in-process: each step gets its own retry budget and its own timeout,
   * and a long pipeline cannot monopolise a worker.
   */
  async advance(videoId: string, jobId: string | null = null): Promise<VideoStatus> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, status: true, lockedAt: true, lockedBy: true },
    });
    if (!video) throw new NotFoundError('Video', videoId);

    if (TERMINAL_VIDEO_STATUSES.includes(video.status)) {
      this.logger.debug(`Video ${videoId} is already ${video.status}; nothing to advance.`);
      return video.status;
    }

    await this.assertGenerationAllowed();

    const step = this.steps.get(video.status) ?? this.resumable.get(video.status);
    if (!step) {
      // READY_FOR_REVIEW and APPROVED have no automatic step: one waits for a
      // person, the other for the publishing module.
      this.logger.debug(`No pipeline step for status ${video.status}; waiting.`);
      return video.status;
    }

    if (!(await this.acquireLock(videoId))) {
      throw new ConflictError('This video is already being processed by another worker.');
    }

    const startedAt = Date.now();
    try {
      if (step.running && video.status !== step.running) {
        await this.transition(videoId, step.running, `Running ${step.name}.`);
      } else if (step.running) {
        this.logger.log(`Video ${videoId}: resuming ${step.name} after an earlier failure.`);
      }

      const result = await step.execute({ videoId, jobId });
      await this.transition(videoId, result.next, result.note ?? null);

      this.logger.log(
        `Video ${videoId}: ${step.name} → ${result.next} in ${Date.now() - startedAt}ms.`,
      );

      if (!result.halt && !TERMINAL_VIDEO_STATUSES.includes(result.next)) {
        await this.enqueueAdvance(videoId, result.next);
      }

      return result.next;
    } catch (error) {
      await this.handleStepFailure(videoId, step, error, jobId);
      throw error;
    } finally {
      await this.releaseLock(videoId);
    }
  }

  /** Starts the pipeline for a freshly created video. */
  async start(videoId: string): Promise<void> {
    await this.assertGenerationAllowed();
    await this.enqueueAdvance(videoId, Status.CREATED);
  }

  /**
   * Records a transition and its audit event in one transaction.
   *
   * Public because approval, rejection and publishing also move a video, and they
   * must go through the same audited path rather than writing `status` directly.
   */
  async transition(
    videoId: string,
    to: VideoStatus,
    note: string | null,
    actorId?: string | null,
  ): Promise<void> {
    const current = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      select: { status: true },
    });

    await this.prisma.$transaction([
      this.prisma.video.update({
        where: { id: videoId },
        data: {
          status: to,
          ...(to === Status.FAILED ? {} : { lastError: null }),
        },
      }),
      this.prisma.videoStatusEvent.create({
        data: { videoId, from: current.status, to, note, actorId: actorId ?? null },
      }),
    ]);
  }

  /** Moves a video to FAILED with a reason an operator can act on. */
  async fail(videoId: string, reason: string, actorId?: string | null): Promise<void> {
    await this.prisma.video.update({
      where: { id: videoId },
      data: { lastError: reason.slice(0, 2000) },
    });
    await this.transition(videoId, Status.FAILED, reason.slice(0, 500), actorId);
  }

  /** Which statuses currently have an automatic step. Used by the health page. */
  registeredStatuses(): VideoStatus[] {
    return [...this.steps.keys()];
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async enqueueAdvance(videoId: string, status: VideoStatus): Promise<void> {
    await this.jobs.enqueue({
      type: JobType.PIPELINE_ADVANCE,
      videoId,
      payload: { videoId },
      // The status is part of the key so each transition is its own unit of work
      // and a retried step does not collide with the next one.
      idempotencyParts: [JobType.PIPELINE_ADVANCE, videoId, status],
    });
  }

  private async assertGenerationAllowed(): Promise<void> {
    const state = await this.settings.getOperationalState();
    if (state.emergencyStop) {
      throw new SystemHaltedError('Emergency stop is active.');
    }
    if (state.generationPaused) {
      throw new SystemHaltedError('Generation is paused by an operator.');
    }
  }

  /**
   * Claims the video with a conditional update.
   *
   * The predicate accepts an unlocked video or one whose lock has expired, so a
   * worker killed mid-step does not strand the video forever.
   */
  private async acquireLock(videoId: string): Promise<boolean> {
    const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);
    const result = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
      },
      data: { lockedAt: new Date(), lockedBy: this.workerId },
    });
    return result.count === 1;
  }

  private async releaseLock(videoId: string): Promise<void> {
    await this.prisma.video
      .updateMany({
        where: { id: videoId, lockedBy: this.workerId },
        data: { lockedAt: null, lockedBy: null },
      })
      .catch(() => undefined);
  }

  /**
   * Decides what a step failure means for the video.
   *
   * A retryable error leaves the status alone so the job's own backoff can try
   * again. A permanent one moves the video to FAILED, because leaving it in an
   * intermediate state would hide it from every dashboard view.
   */
  private async handleStepFailure(
    videoId: string,
    step: PipelineStep,
    error: unknown,
    jobId: string | null,
  ): Promise<void> {
    const message = describeError(error);
    const permanent = error instanceof AppError && !error.retryable;
    // A retryable error on the final attempt has no retry left to wait for. Leaving
    // the video in progress would make it look alive while nothing is running.
    const exhausted = !permanent && (await this.isFinalAttempt(jobId));

    await this.systemLog.error(
      'PipelineOrchestrator',
      `Step ${step.name} failed for video ${videoId}.`,
      error,
      { videoId },
    );

    if (permanent || exhausted) {
      const suffix = exhausted ? ' (retries exhausted)' : '';
      await this.fail(videoId, `${step.name}: ${message}${suffix}`);
      return;
    }

    // Keep the reason visible while the retry is pending.
    await this.prisma.video
      .update({ where: { id: videoId }, data: { lastError: message.slice(0, 2000) } })
      .catch(() => undefined);
  }

  /** True when the running job has used its last attempt. Unknown job: assume not. */
  private async isFinalAttempt(jobId: string | null): Promise<boolean> {
    if (!jobId) return false;
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { attempts: true, maxAttempts: true },
    });
    return job !== null && job.attempts >= job.maxAttempts;
  }
}

export { InvalidStateTransitionError };
