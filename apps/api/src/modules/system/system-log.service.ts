import { Injectable, Logger } from '@nestjs/common';
import { type LogLevel } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { describeError } from '@/common/errors';
import { redact } from '@/common/utils/redact';

/**
 * Persisted, queryable application log.
 *
 * This is deliberately *not* the transport for every debug line — stdout and
 * Cloud Logging handle volume. What lands here is what an operator needs to see
 * in the dashboard: pipeline milestones, failures, and operator-relevant warnings.
 *
 * Everything written goes through `redact()` first, so a provider error that
 * happens to echo an API key cannot be persisted in plaintext.
 */

export interface LogContext {
  videoId?: string | null;
  jobId?: string | null;
  [key: string]: unknown;
}

@Injectable()
export class SystemLogService {
  private readonly logger = new Logger('SystemLog');

  constructor(private readonly prisma: PrismaService) {}

  info(service: string, message: string, context?: LogContext): Promise<void> {
    return this.write('INFO', service, message, context);
  }

  warn(service: string, message: string, context?: LogContext): Promise<void> {
    return this.write('WARN', service, message, context);
  }

  error(service: string, message: string, error?: unknown, context?: LogContext): Promise<void> {
    return this.write('ERROR', service, message, context, error);
  }

  fatal(service: string, message: string, error?: unknown, context?: LogContext): Promise<void> {
    return this.write('FATAL', service, message, context, error);
  }

  private async write(
    level: LogLevel,
    service: string,
    message: string,
    context?: LogContext,
    error?: unknown,
  ): Promise<void> {
    const { videoId, jobId, ...rest } = context ?? {};

    try {
      await this.prisma.systemLog.create({
        data: {
          level,
          service,
          message: message.slice(0, 2000),
          context: Object.keys(rest).length > 0 ? (redact(rest) as never) : undefined,
          error: error !== undefined ? String(redact(describeError(error))).slice(0, 4000) : null,
          videoId: videoId ?? null,
          jobId: jobId ?? null,
        },
      });
    } catch (writeError) {
      // Logging must never be the reason a request fails. Fall back to stdout.
      this.logger.error(
        `Could not persist ${level} log from ${service}: ${describeError(writeError)}`,
      );
    }
  }

  /** Removes log rows older than the retention window. Called by a cron job. */
  async prune(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const result = await this.prisma.systemLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return result.count;
  }
}
