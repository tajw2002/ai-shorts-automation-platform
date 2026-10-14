import { Injectable, Logger } from '@nestjs/common';
import { okHealth, type ProviderHealth } from '../provider.types';
import { type EnqueueRequest, type QueueProvider } from './queue-provider.interface';

/**
 * In-process queue for local development and single-instance deployments.
 *
 * The durable queue is the `Job` table, not this object. `enqueue` therefore has
 * almost nothing to do: the row is already committed by the time it is called, and
 * `JobPollerService` picks up anything whose `runAfter` has passed. That is a
 * deliberate choice — it means a crash mid-enqueue cannot lose work, and a
 * restart resumes exactly where it left off, which an in-memory timer queue
 * could not promise.
 *
 * The counters here exist for observability only.
 */
@Injectable()
export class InMemoryQueueProvider implements QueueProvider {
  readonly name = 'inmemory';
  private readonly logger = new Logger(InMemoryQueueProvider.name);
  private enqueued = 0;
  private cancelled = 0;
  /** Job ids the operator asked to cancel before the poller reached them. */
  private readonly cancelRequests = new Set<string>();

  isConfigured(): boolean {
    return true;
  }

  missingConfiguration(): string[] {
    return [];
  }

  async healthCheck(): Promise<ProviderHealth> {
    return okHealth('In-process queue; jobs are drained from the database by the poller.', 0);
  }

  describe(): Record<string, string | number | boolean | null> {
    return {
      durableStore: 'postgres:Job',
      enqueued: this.enqueued,
      cancelled: this.cancelled,
      scalesToZero: false,
    };
  }

  async enqueue(request: EnqueueRequest): Promise<void> {
    this.enqueued += 1;
    this.cancelRequests.delete(request.jobId);
    this.logger.debug(
      `Queued ${request.type} job ${request.jobId}` +
        (request.runAfter ? ` for ${request.runAfter.toISOString()}` : ''),
    );
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled += 1;
    this.cancelRequests.add(jobId);
  }

  /** Consulted by the poller so a cancellation lands even between polls. */
  isCancelRequested(jobId: string): boolean {
    return this.cancelRequests.has(jobId);
  }

  async pendingCount(): Promise<number | null> {
    // The database is authoritative; the domain reports this rather than the port.
    return null;
  }
}
