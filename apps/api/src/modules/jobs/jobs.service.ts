import { Inject, Injectable, Logger } from '@nestjs/common';
import { type JobStatus, type JobType, type Paginated, type Pagination } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { QUEUE_PROVIDER } from '@/providers/provider.tokens';
import { type QueueProvider } from '@/providers/queue/queue-provider.interface';
import { buildIdempotencyKey } from '@/common/crypto/tokens';
import { computeBackoffDelay } from '@/common/resilience/retry';
import { describeError, isRetryable, NotFoundError } from '@/common/errors';

/**
 * Job lifecycle.
 *
 * The `Job` table is the durable queue; the `QueueProvider` is only the delivery
 * mechanism. That split is what makes at-least-once delivery safe:
 *
 *  - Enqueuing writes the row first, then notifies the queue. A crash between
 *    the two leaves a row the poller will still pick up.
 *  - Claiming is a single conditional UPDATE, so two workers racing for the same
 *    job produce exactly one winner.
 *  - The idempotency key is deterministic, so a duplicate delivery collapses into
 *    the row that already exists instead of doing the work twice.
 */

export interface EnqueueJobInput {
  type: JobType;
  payload?: Record<string, unknown>;
  videoId?: string | null;
  /**
   * Parts that uniquely identify this unit of work. Defaults to type + video,
   * which is right for pipeline steps; callers that legitimately need repeats
   * (a scheduled analytics sync) add a time bucket.
   */
  idempotencyParts?: Array<string | number | null | undefined>;
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  videoId: string | null;
  attempts: number;
  maxAttempts: number;
}

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  /** Identifies this process in `claimedBy`, for stuck-job diagnostics. */
  private readonly workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(QUEUE_PROVIDER) private readonly queue: QueueProvider,
  ) {}

  /**
   * Creates (or reuses) a job and hands it to the queue.
   *
   * Returns the job id in both cases. Re-enqueuing an identical unit of work is a
   * no-op by design — it is what lets callers be careless about retries.
   */
  async enqueue(input: EnqueueJobInput): Promise<string> {
    const idempotencyKey = buildIdempotencyKey(
      input.idempotencyParts ?? [input.type, input.videoId],
    );

    const existing = await this.prisma.job.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.status === 'QUEUED' || existing.status === 'RUNNING') {
        this.logger.debug(`Job ${existing.id} (${input.type}) already pending; not re-enqueuing.`);
        return existing.id;
      }
      // A finished job with the same key means this work was already done. Reset
      // it so an explicit re-run (a regenerate, say) can proceed.
      const revived = await this.prisma.job.update({
        where: { id: existing.id },
        data: {
          status: 'QUEUED',
          attempts: 0,
          errorMessage: null,
          startedAt: null,
          finishedAt: null,
          runAfter: input.runAfter ?? new Date(),
          payload: (input.payload ?? {}) as never,
        },
      });
      await this.notifyQueue(revived.id, input, idempotencyKey);
      return revived.id;
    }

    const job = await this.prisma.job.create({
      data: {
        type: input.type,
        payload: (input.payload ?? {}) as never,
        videoId: input.videoId ?? null,
        idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.config.quotas.maxJobAttempts,
        runAfter: input.runAfter ?? new Date(),
        priority: input.priority ?? 0,
      },
    });

    await this.notifyQueue(job.id, input, idempotencyKey);
    return job.id;
  }

  /**
   * Atomically claims one due job.
   *
   * The `updateMany` with a status predicate is the lock: only the worker whose
   * update matches a row gets it. Returns null when there is nothing to do.
   */
  async claimNext(): Promise<ClaimedJob | null> {
    const candidate = await this.prisma.job.findFirst({
      where: { status: 'QUEUED', runAfter: { lte: new Date() } },
      orderBy: [{ priority: 'desc' }, { runAfter: 'asc' }],
      select: { id: true },
    });
    if (!candidate) return null;

    return this.claimById(candidate.id);
  }

  /** Claims a specific job — the path Cloud Tasks takes when it calls back. */
  async claimById(jobId: string): Promise<ClaimedJob | null> {
    const result = await this.prisma.job.updateMany({
      where: { id: jobId, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        attempts: { increment: 1 },
        claimedBy: this.workerId,
      },
    });

    // Zero rows means another worker won the race, or the job is not runnable.
    if (result.count === 0) return null;

    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) return null;

    return {
      id: job.id,
      type: job.type,
      payload: (job.payload ?? {}) as Record<string, unknown>,
      videoId: job.videoId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    };
  }

  async markSucceeded(jobId: string): Promise<void> {
    await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'SUCCEEDED', finishedAt: new Date(), errorMessage: null },
    });
  }

  /**
   * Records a failure and decides between a retry and a dead letter.
   *
   * Both bounds are respected: the attempt count, and whether the error is the
   * kind that could plausibly succeed on a retry. A validation error retried
   * three times is three times the cost for the same outcome.
   */
  async markFailed(
    jobId: string,
    error: unknown,
    options: { correlationId?: string } = {},
  ): Promise<{ willRetry: boolean; runAfter: Date | null }> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundError('Job', jobId);

    const message = describeError(error).slice(0, 2000);
    const canRetry = job.attempts < job.maxAttempts && isRetryable(error);

    if (!canRetry) {
      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          status: job.attempts >= job.maxAttempts ? 'DEAD_LETTER' : 'FAILED',
          finishedAt: new Date(),
          errorMessage: message,
          correlationId: options.correlationId ?? null,
        },
      });
      this.logger.error(`Job ${jobId} (${job.type}) failed permanently: ${message}`);
      return { willRetry: false, runAfter: null };
    }

    const delayMs = computeBackoffDelay(job.attempts, {
      baseDelayMs: 5_000,
      maxDelayMs: 300_000,
      jitter: true,
    });
    const runAfter = new Date(Date.now() + delayMs);

    await this.prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'QUEUED',
        runAfter,
        errorMessage: message,
        startedAt: null,
        claimedBy: null,
        correlationId: options.correlationId ?? null,
      },
    });

    await this.queue
      .enqueue({
        jobId,
        type: job.type,
        idempotencyKey: `${job.idempotencyKey}-retry-${job.attempts}`,
        payload: (job.payload ?? {}) as Record<string, unknown>,
        runAfter,
      })
      .catch((queueError: unknown) => {
        // The row is already QUEUED, so the poller remains a safety net.
        this.logger.warn(`Could not re-queue job ${jobId}: ${describeError(queueError)}`);
      });

    this.logger.warn(
      `Job ${jobId} (${job.type}) failed on attempt ${job.attempts}/${job.maxAttempts}; ` +
        `retrying in ${Math.round(delayMs / 1000)}s.`,
    );
    return { willRetry: true, runAfter };
  }

  async cancel(jobId: string): Promise<void> {
    await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    await this.queue.cancel(jobId).catch(() => undefined);
  }

  /** Cancels everything outstanding. Used by the emergency stop. */
  async cancelAllPending(reason: string): Promise<number> {
    const pending = await this.prisma.job.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });

    const result = await this.prisma.job.updateMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', finishedAt: new Date(), errorMessage: reason },
    });

    await Promise.all(pending.map((job) => this.queue.cancel(job.id).catch(() => undefined)));
    return result.count;
  }

  /**
   * Returns jobs stuck in RUNNING past a plausible execution window to QUEUED.
   *
   * A worker killed mid-job (a Cloud Run instance being recycled) leaves its
   * claim behind; without this the job would never run again.
   */
  async requeueStale(olderThanMs = 30 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.job.updateMany({
      where: { status: 'RUNNING', startedAt: { lt: cutoff } },
      data: { status: 'QUEUED', claimedBy: null, startedAt: null },
    });
    if (result.count > 0) {
      this.logger.warn(`Requeued ${result.count} stale job(s) abandoned by a dead worker.`);
    }
    return result.count;
  }

  async list(
    pagination: Pagination,
    filters: { status?: JobStatus; type?: JobType; videoId?: string } = {},
  ): Promise<Paginated<Awaited<ReturnType<PrismaService['job']['findMany']>>[number]>> {
    const where = {
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.videoId ? { videoId: filters.videoId } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.job.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (pagination.page - 1) * pagination.pageSize,
        take: pagination.pageSize,
      }),
      this.prisma.job.count({ where }),
    ]);

    return {
      items,
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.pageSize)),
    };
  }

  async countByStatus(status: JobStatus, since?: Date): Promise<number> {
    return this.prisma.job.count({
      where: { status, ...(since ? { createdAt: { gte: since } } : {}) },
    });
  }

  private async notifyQueue(
    jobId: string,
    input: EnqueueJobInput,
    idempotencyKey: string,
  ): Promise<void> {
    try {
      await this.queue.enqueue({
        jobId,
        type: input.type,
        idempotencyKey,
        payload: input.payload ?? {},
        runAfter: input.runAfter,
        priority: input.priority,
      });
    } catch (error) {
      // The durable row exists, so this is recoverable: the poller (or a manual
      // retry) will still pick it up. Log loudly and carry on.
      this.logger.error(
        `Job ${jobId} was persisted but could not be handed to the queue: ${describeError(error)}`,
      );
    }
  }
}
