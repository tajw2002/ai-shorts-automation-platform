import { type JobType } from '@shorts/contracts';
import { type BaseProvider } from '../provider.types';

/**
 * The queue port.
 *
 * Two implementations with the same contract:
 *  - `inmemory` drains a database-backed job table from inside the process. Good
 *    for local development and a single-instance deployment; nothing is lost on
 *    restart because the durable state is the `Job` row, not the in-memory timer.
 *  - `cloudtasks` hands the job to Google Cloud Tasks, which calls back into
 *    `/internal/tasks/run` with an OIDC token. This is what lets Cloud Run scale
 *    to zero and still process work reliably.
 */

export interface EnqueueRequest {
  jobId: string;
  type: JobType;
  /** Duplicate deliveries carrying the same key must collapse to one execution. */
  idempotencyKey: string;
  payload: Record<string, unknown>;
  /** Earliest execution time. Used for backoff and for scheduled publishing. */
  runAfter?: Date;
  /** Higher runs first, where the implementation supports it. */
  priority?: number;
}

export interface QueueProvider extends BaseProvider {
  enqueue(request: EnqueueRequest): Promise<void>;
  /** Best-effort. Cloud Tasks can delete a pending task; an in-flight one cannot be stopped. */
  cancel(jobId: string): Promise<void>;
  /** Number of tasks the backend believes are pending, when it can tell us. */
  pendingCount(): Promise<number | null>;
}
