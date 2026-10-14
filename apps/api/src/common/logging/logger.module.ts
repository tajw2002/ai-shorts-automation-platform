import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppConfig } from '@/config/app-config';
import { PINO_REDACT_PATHS } from '@/common/utils/redact';

/**
 * Is `pino-pretty` actually installed?
 *
 * It is a development convenience and is pruned from the production image, so
 * asking for it unconditionally in a non-production `NODE_ENV` crashes the
 * process at boot — which is exactly what happened the first time this ran in a
 * container with `NODE_ENV=development`. Pretty output is nice to have; booting
 * is not optional, so resolve it defensively and fall back to JSON.
 */
function prettyTransportAvailable(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/**
 * Structured logging.
 *
 * Every line carries a timestamp, level, service and request id. Secrets are
 * removed by pino's own redaction paths before serialisation, so there is no
 * window in which a credential could reach the transport.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.app.logLevel,
          // Pretty output is a developer convenience only; production emits JSON
          // so Cloud Logging can index the fields.
          transport:
            config.app.isProduction || config.app.isTest || !prettyTransportAvailable()
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'HH:MM:ss.l' },
                },
          redact: { paths: [...PINO_REDACT_PATHS], censor: '[redacted]' },
          genReqId: (req: IncomingMessage) =>
            (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
          customProps: () => ({ service: 'api' }),
          autoLogging: {
            // Health probes would otherwise dominate the log volume.
            ignore: (req: IncomingMessage) =>
              req.url === '/liveness' || req.url === '/readiness' || req.url === '/metrics',
          },
          serializers: {
            req: (req: IncomingMessage & { id?: string; params?: unknown; query?: unknown }) => ({
              id: req.id,
              method: req.method,
              // Query strings can carry tokens (OAuth callbacks); path only.
              url: (req.url ?? '').split('?')[0],
            }),
            res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
          },
          customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
            if (err) return 'error';
            if (res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
          },
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class AppLoggerModule {}
