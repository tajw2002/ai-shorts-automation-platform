import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { type ApiErrorBody } from '@shorts/contracts';
import { AppError, describeError } from '@/common/errors';
import { AppConfig } from '@/config/app-config';
import { redact } from '@/common/utils/redact';

/**
 * The single place an exception becomes an HTTP response.
 *
 * Two rules hold without exception:
 *  1. The client gets a stable `code` and a request id, never a stack trace and
 *     never an internal message from an unexpected failure.
 *  2. The full detail is logged server-side, after redaction.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly config: AppConfig) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? (request.headers['x-request-id'] as string) ?? 'unknown';

    const { status, body } = this.toErrorBody(exception, requestId);

    if (status >= 500) {
      this.logger.error(
        { requestId, path: request.path, err: redact(exception) },
        `Unhandled error: ${describeError(exception)}`,
      );
    } else {
      this.logger.warn(
        { requestId, path: request.path, code: body.code },
        `Request failed: ${body.message}`,
      );
    }

    response.status(status).json(body);
  }

  private toErrorBody(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ApiErrorBody } {
    const timestamp = new Date().toISOString();

    if (exception instanceof AppError) {
      return {
        status: exception.status,
        body: {
          statusCode: exception.status,
          code: exception.code,
          message: exception.message,
          requestId,
          details: exception.details,
          timestamp,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);
      return {
        status,
        body: {
          statusCode: status,
          code:
            status === 404 ? 'NOT_FOUND' : status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED',
          message: Array.isArray(message) ? message.join('; ') : message,
          requestId,
          timestamp,
        },
      };
    }

    // Anything unexpected: the client learns nothing beyond "it broke" plus the
    // id needed to ask an operator what happened.
    return {
      status: 500,
      body: {
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: this.config.app.isProduction
          ? 'An unexpected error occurred.'
          : describeError(exception),
        requestId,
        timestamp,
      },
    };
  }
}
