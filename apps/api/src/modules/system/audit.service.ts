import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { redact } from '@/common/utils/redact';
import { describeError } from '@/common/errors';

/**
 * Records who did what.
 *
 * Separate from `SystemLog` on purpose: system logs are operational noise with a
 * retention window, whereas the audit trail answers "who approved this video" and
 * "who turned off the emergency stop" and is kept.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: {
    userId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: entry.userId ?? null,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId ?? null,
          metadata: entry.metadata ? (redact(entry.metadata) as never) : undefined,
          ipAddress: entry.ipAddress ?? null,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to write audit entry: ${describeError(error)}`);
    }
  }
}
