import { Injectable, Logger } from '@nestjs/common';
import { CloudTasksClient } from '@google-cloud/tasks';
import { AppConfig } from '@/config/app-config';
import { ProviderError, ProviderNotConfiguredError } from '@/common/errors';
import { errorHealth, okHealth, type ProviderHealth } from '../provider.types';
import { type EnqueueRequest, type QueueProvider } from './queue-provider.interface';

/**
 * Google Cloud Tasks adapter.
 *
 * Each job becomes an HTTP task that calls back into `/internal/tasks/run`,
 * authenticated with an OIDC token minted for the configured service account.
 * That is what lets the Cloud Run service scale to zero and still process work:
 * Cloud Tasks holds the queue and wakes an instance when there is something to do.
 *
 * The task name is derived from the job's idempotency key, so Cloud Tasks itself
 * de-duplicates a double enqueue — a second create with the same name is rejected
 * with ALREADY_EXISTS, which we treat as success.
 */
@Injectable()
export class CloudTasksQueueProvider implements QueueProvider {
  readonly name = 'cloudtasks';
  private readonly logger = new Logger(CloudTasksQueueProvider.name);
  private client: CloudTasksClient | null = null;

  constructor(private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!this.config.gcp.projectId) missing.push('GCP_PROJECT_ID');
    if (!this.config.gcp.tasksQueue) missing.push('CLOUD_TASKS_QUEUE');
    if (!this.config.gcp.tasksInvokerServiceAccount) missing.push('CLOUD_TASKS_INVOKER_SA');
    return missing;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const missing = this.missingConfiguration();
    if (missing.length > 0) return errorHealth(`Not configured. Missing: ${missing.join(', ')}`);

    const startedAt = Date.now();
    try {
      await this.sdk().getQueue({ name: this.queuePath() });
      return okHealth(`Queue ${this.config.gcp.tasksQueue} reachable`, Date.now() - startedAt);
    } catch (error) {
      return errorHealth(error instanceof Error ? error.message : 'Cloud Tasks unreachable');
    }
  }

  describe(): Record<string, string | number | boolean | null> {
    return {
      project: this.config.gcp.projectId || null,
      location: this.config.gcp.tasksLocation,
      queue: this.config.gcp.tasksQueue,
      targetUrl: this.targetUrl(),
      scalesToZero: true,
    };
  }

  async enqueue(request: EnqueueRequest): Promise<void> {
    const missing = this.missingConfiguration();
    if (missing.length > 0) throw new ProviderNotConfiguredError('QUEUE', this.name, missing);

    const payload = {
      jobId: request.jobId,
      type: request.type,
      idempotencyKey: request.idempotencyKey,
      payload: request.payload,
    };

    try {
      await this.sdk().createTask({
        parent: this.queuePath(),
        task: {
          name: `${this.queuePath()}/tasks/${sanitizeTaskId(request.idempotencyKey)}`,
          httpRequest: {
            url: this.targetUrl(),
            httpMethod: 'POST',
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(payload)),
            oidcToken: {
              serviceAccountEmail: this.config.gcp.tasksInvokerServiceAccount,
              audience: this.config.gcp.tasksOidcAudience,
            },
          },
          ...(request.runAfter
            ? { scheduleTime: { seconds: Math.floor(request.runAfter.getTime() / 1000) } }
            : {}),
        },
      });
    } catch (error) {
      if (isAlreadyExists(error)) {
        // A duplicate enqueue is the system working as designed, not a failure.
        this.logger.debug(`Task for job ${request.jobId} already queued; ignoring duplicate.`);
        return;
      }
      throw new ProviderError({
        provider: this.name,
        message: `Failed to enqueue job ${request.jobId}.`,
        retryable: true,
        cause: error,
      });
    }
  }

  async cancel(jobId: string): Promise<void> {
    // Cloud Tasks can delete a task that has not started; one already in flight
    // cannot be stopped, which is why the runner also re-checks job status.
    try {
      await this.sdk().deleteTask({
        name: `${this.queuePath()}/tasks/${sanitizeTaskId(jobId)}`,
      });
    } catch (error) {
      this.logger.debug(`Could not delete task for job ${jobId}: ${String(error)}`);
    }
  }

  async pendingCount(): Promise<number | null> {
    // Cloud Tasks does not expose a queue depth; the database is authoritative.
    return null;
  }

  private sdk(): CloudTasksClient {
    this.client ??= new CloudTasksClient();
    return this.client;
  }

  private queuePath(): string {
    return this.sdk().queuePath(
      this.config.gcp.projectId,
      this.config.gcp.tasksLocation,
      this.config.gcp.tasksQueue,
    );
  }

  private targetUrl(): string {
    return `${this.config.app.apiBaseUrl}/internal/tasks/run`;
  }
}

/** Cloud Tasks task ids allow letters, digits, hyphens and underscores only. */
export function sanitizeTaskId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 500);
}

function isAlreadyExists(error: unknown): boolean {
  // gRPC status 6 == ALREADY_EXISTS.
  return typeof error === 'object' && error !== null && (error as { code?: number }).code === 6;
}
