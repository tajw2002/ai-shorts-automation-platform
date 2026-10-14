/**
 * Domain error hierarchy.
 *
 * Every error the platform raises deliberately carries a stable machine-readable
 * `code`, an HTTP status and a `retryable` flag. The global exception filter maps
 * these to responses; the job runner uses `retryable` to decide between a backoff
 * and a dead letter.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'BUDGET_EXCEEDED'
  | 'QUOTA_EXCEEDED'
  | 'SYSTEM_HALTED'
  | 'SAFETY_BLOCKED'
  | 'DUPLICATE_CONTENT'
  | 'QUALITY_CHECK_FAILED'
  | 'INVALID_STATE_TRANSITION'
  | 'MEDIA_PROCESSING_FAILED'
  | 'UPLOAD_FAILED'
  | 'INTERNAL_ERROR';

export interface AppErrorOptions {
  code: ErrorCode;
  status: number;
  message: string;
  /** Safe to return to the client. Must never contain credentials. */
  details?: unknown;
  /** Whether a retry could plausibly succeed. */
  retryable?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'VALIDATION_FAILED', status: 400, message, details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required.') {
    super({ code: 'UNAUTHENTICATED', status: 401, message });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource.') {
    super({ code: 'FORBIDDEN', status: 403, message });
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super({
      code: 'NOT_FOUND',
      status: 404,
      message: id ? `${entity} '${id}' was not found.` : `${entity} was not found.`,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'CONFLICT', status: 409, message, details });
  }
}

/** An upstream provider failed. `retryable` decides whether the job backs off. */
export class ProviderError extends AppError {
  readonly provider: string;

  constructor(options: {
    provider: string;
    message: string;
    retryable?: boolean;
    status?: number;
    details?: unknown;
    cause?: unknown;
  }) {
    super({
      code: 'PROVIDER_ERROR',
      status: 502,
      message: `[${options.provider}] ${options.message}`,
      retryable: options.retryable ?? false,
      details: options.details,
      cause: options.cause,
    });
    this.provider = options.provider;
  }
}

export class ProviderTimeoutError extends AppError {
  constructor(provider: string, timeoutMs: number, cause?: unknown) {
    super({
      code: 'PROVIDER_TIMEOUT',
      status: 504,
      message: `[${provider}] timed out after ${timeoutMs}ms.`,
      retryable: true,
      cause,
    });
  }
}

export class ProviderNotConfiguredError extends AppError {
  constructor(kind: string, implementation: string, missing: string[]) {
    super({
      code: 'PROVIDER_NOT_CONFIGURED',
      status: 503,
      message:
        `The ${kind} provider '${implementation}' is selected but not configured. ` +
        `Missing: ${missing.join(', ')}.`,
      details: { kind, implementation, missing },
    });
  }
}

export class BudgetExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'BUDGET_EXCEEDED', status: 429, message, details });
  }
}

/** Emergency stop, or generation/uploads paused by an operator. */
export class SystemHaltedError extends AppError {
  constructor(reason: string) {
    super({
      code: 'SYSTEM_HALTED',
      status: 503,
      message: `The system is halted: ${reason}`,
      details: { reason },
    });
  }
}

export class SafetyBlockedError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'SAFETY_BLOCKED', status: 422, message, details });
  }
}

export class DuplicateContentError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'DUPLICATE_CONTENT', status: 409, message, details });
  }
}

export class QualityCheckFailedError extends AppError {
  constructor(message: string, details?: unknown) {
    super({ code: 'QUALITY_CHECK_FAILED', status: 422, message, details });
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(entity: string, from: string, to: string) {
    super({
      code: 'INVALID_STATE_TRANSITION',
      status: 409,
      message: `${entity} cannot move from ${from} to ${to}.`,
      details: { from, to },
    });
  }
}

export class MediaProcessingError extends AppError {
  constructor(message: string, details?: unknown, cause?: unknown) {
    super({
      code: 'MEDIA_PROCESSING_FAILED',
      status: 500,
      message,
      details,
      cause,
      retryable: true,
    });
  }
}

export class UploadFailedError extends AppError {
  constructor(message: string, retryable = true, cause?: unknown) {
    super({ code: 'UPLOAD_FAILED', status: 502, message, retryable, cause });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** True when a retry is worth attempting. Unknown errors are treated as transient. */
export function isRetryable(error: unknown): boolean {
  if (isAppError(error)) return error.retryable;
  if (error instanceof TypeError || error instanceof SyntaxError) return false;
  return true;
}

/** Extracts a log-safe message from anything that was thrown. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unserialisable error value';
  }
}
