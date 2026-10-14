import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config';

/**
 * Process entry point.
 *
 * Boot order matters: configuration is validated first (so a bad environment
 * fails immediately with a readable message rather than three requests later),
 * then security middleware, then the routes.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Body size is capped well below any legitimate dashboard payload; media
    // never travels through the JSON body.
    bodyParser: true,
  });

  app.useLogger(app.get(PinoLogger));
  const config = app.get(AppConfig);
  const logger = app.get(PinoLogger);

  app.use(cookieParser());

  app.use(
    helmet({
      // The API serves JSON and media, never HTML, so a restrictive CSP costs
      // nothing and removes an entire class of reflected-content risk.
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      // HSTS only makes sense once TLS is actually terminated in front of us.
      hsts: config.app.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );

  app.enableCors({
    origin: config.security.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    maxAge: 600,
  });

  // Probes and machine endpoints sit outside the versioned API surface: an
  // infrastructure health check must not break when the API version changes.
  app.setGlobalPrefix('api/v1', {
    exclude: ['liveness', 'readiness', 'internal/(.*)'],
  });

  if (!config.app.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('AI Shorts Automation Platform')
        .setDescription(
          'Operator API. Disabled in production — the dashboard is the supported surface.',
        )
        .setVersion(config.app.version)
        .addCookieAuth('shorts_session')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  // Cloud Run sends SIGTERM and waits; letting Nest close gracefully means an
  // in-flight upload or render is not cut off mid-write.
  app.enableShutdownHooks();

  await app.listen(config.app.port, '0.0.0.0');

  logger.log(
    {
      role: config.app.role,
      env: config.app.env,
      port: config.app.port,
      dryRun: config.safety.dryRun,
      providers: config.providers,
    },
    `AI Shorts Automation Platform listening on port ${config.app.port}`,
  );

  if (config.safety.dryRun) {
    logger.warn(
      'DRY_RUN is enabled: mock providers are in use and no video will be uploaded to YouTube.',
    );
  }
  if (config.safety.emergencyStop) {
    logger.warn('EMERGENCY_STOP is set: generation and uploads are halted.');
  }
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if configuration failed, so this is the one
  // place a bare console write is the right call.

  console.error('Failed to start the application:\n', error);
  process.exitCode = 1;
});
