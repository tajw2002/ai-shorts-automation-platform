import { ProviderTimeoutError, isRetryable } from '../errors';

export interface RetryOptions {
  /** Total attempts, including the first. Must be >= 1. */
  attempts: number;
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** Upper bound on any single delay. */
  maxDelayMs: number;
  /**
   * Full jitter (AWS-style) spreads retries out so a fleet of workers does not
   * synchronise into a thundering herd. Disabled in tests for determinism.
   */
  jitter: boolean;
  /** Decides whether a given failure is worth retrying. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each backoff wait — used for logging and metrics. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Optional deadline for the whole sequence, including waits. */
  totalTimeoutMs?: number;
  /** Injectable clock, so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for jitter, so tests are deterministic. */
  random?: () => number;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = Object.freeze({
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: true,
});

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff delay for a given retry number (1-based), with optional
 * full jitter. Exported separately so the schedule can be asserted in tests
 * without running the retries.
 */
export function computeBackoffDelay(
  retryNumber: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'jitter'> & { random?: () => number },
): number {
  const exponential = options.baseDelayMs * 2 ** (retryNumber - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  if (!options.jitter) return Math.round(capped);
  const random = options.random ?? Math.random;
  return Math.round(random() * capped);
}

/**
 * Runs `operation` with bounded retries and exponential backoff.
 *
 * The loop is bounded by `attempts` and, optionally, `totalTimeoutMs`. There is no
 * code path here that can spin forever.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> & { label?: string } = {},
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options };
  if (opts.attempts < 1) throw new RangeError('retry attempts must be >= 1');

  const sleep = opts.sleep ?? defaultSleep;
  const shouldRetry = opts.shouldRetry ?? ((error) => isRetryable(error));
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === opts.attempts;
      if (isLastAttempt || !shouldRetry(error, attempt)) break;

      const delay = computeBackoffDelay(attempt, opts);

      if (opts.totalTimeoutMs !== undefined) {
        const elapsed = Date.now() - startedAt;
        if (elapsed + delay >= opts.totalTimeoutMs) break;
      }

      opts.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Rejects with a typed timeout error if `promise` has not settled in time.
 *
 * `onTimeout` lets the caller abort the underlying work (e.g. an AbortController)
 * so a timed-out request does not keep a socket open.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new ProviderTimeoutError(label, timeoutMs));
        }, timeoutMs);
        // Do not hold the event loop open purely for a timeout.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Polls `check` until it reports completion or the deadline passes.
 *
 * Used for provider jobs that expose an async status endpoint. Always bounded.
 */
export async function pollUntil<T>(
  check: () => Promise<{ done: boolean; value?: T }>,
  options: {
    intervalMs: number;
    timeoutMs: number;
    label: string;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onPoll?: (elapsedMs: number) => void;
  },
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;

  for (;;) {
    const result = await check();
    if (result.done) {
      if (result.value === undefined) {
        throw new Error(`${options.label}: polling completed without a value`);
      }
      return result.value;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new ProviderTimeoutError(options.label, options.timeoutMs);
    }
    options.onPoll?.(options.timeoutMs - remaining);
    await sleep(Math.min(options.intervalMs, remaining));
  }
}
