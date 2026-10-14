import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppConfig } from '@/config/app-config';
import { ConflictError, NotFoundError } from '@/common/errors';

/**
 * The single PrismaClient for the process.
 *
 * Cloud Run scales to many small instances, so the connection pool is kept
 * deliberately modest — the database's max_connections is the shared resource,
 * not this instance's throughput.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfig) {
    super({
      datasources: { db: { url: config.raw.DATABASE_URL } },
      log: config.app.isProduction
        ? [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ],
      errorFormat: 'minimal',
    });
  }

  async onModuleInit(): Promise<void> {
    // Prisma's typed event emitter needs the cast because the log levels are
    // configured dynamically above.
    (this as unknown as { $on: (e: string, cb: (event: { message: string }) => void) => void }).$on(
      'error',
      (event) => this.logger.error(event.message),
    );
    (this as unknown as { $on: (e: string, cb: (event: { message: string }) => void) => void }).$on(
      'warn',
      (event) => this.logger.warn(event.message),
    );
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Cheap round-trip used by the readiness probe and the health page. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}

/**
 * Translates Prisma's error codes into the platform's domain errors so callers
 * never have to know that Prisma exists, and so the API returns 404/409 instead
 * of a generic 500.
 */
export function translatePrismaError(error: unknown, entity: string): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2025':
        throw new NotFoundError(entity);
      case 'P2002': {
        const target = (error.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
        throw new ConflictError(`A ${entity} with this ${target} already exists.`);
      }
      case 'P2003':
        throw new ConflictError(`${entity} references a record that does not exist.`);
      default:
        break;
    }
  }
  throw error;
}

export { Prisma };
