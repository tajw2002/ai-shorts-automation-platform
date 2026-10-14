import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AppConfigModule, loadAppConfig } from '@/config/config.module';
import { AppConfig } from '@/config/app-config';
import { AppLoggerModule } from '@/common/logging/logger.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { FfmpegModule } from '@/infrastructure/ffmpeg/ffmpeg.module';
import { ProvidersModule } from '@/providers/providers.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { RequestIdMiddleware } from '@/common/middleware/request-id.middleware';

import { SystemModule } from '@/modules/system/system.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { CostModule } from '@/modules/cost/cost.module';
import { SafetyModule } from '@/modules/safety/safety.module';
import { SimilarityModule } from '@/modules/similarity/similarity.module';
import { CharactersModule } from '@/modules/characters/characters.module';
import { ContentModule } from '@/modules/content/content.module';
import { AssetsModule } from '@/modules/assets/assets.module';
import { MediaModule } from '@/modules/media/media.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { PipelineModule } from '@/modules/pipeline/pipeline.module';
import { YouTubeModule } from '@/modules/youtube/youtube.module';
import { VideosModule } from '@/modules/videos/videos.module';
import { AnalyticsModule } from '@/modules/analytics/analytics.module';
import { SchedulerModule } from '@/modules/scheduler/scheduler.module';
import { DashboardModule } from '@/modules/dashboard/dashboard.module';
import { WorkerModule } from '@/modules/worker/worker.module';
import { MaintenanceService } from '@/modules/worker/maintenance.service';

/**
 * Application root.
 *
 * Three cross-cutting concerns are registered globally rather than per-controller,
 * because each one is a security or correctness property that must not depend on
 * a developer remembering to add a decorator:
 *
 *  - `RequestIdMiddleware` — every response carries a correlation id, including
 *    those rejected by a guard before any interceptor could run.
 *  - `AuthGuard`   — every route is authenticated unless explicitly `@Public()`.
 *  - `ThrottlerGuard` — every route is rate limited.
 *  - `AllExceptionsFilter` — no stack trace or internal message ever reaches a client.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    PrismaModule,
    FfmpegModule,
    ProvidersModule,
    ScheduleModule.forRoot(),

    ThrottlerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        throttlers: [
          {
            name: 'default',
            ttl: config.security.rateLimit.windowSeconds * 1000,
            limit: config.security.rateLimit.maxRequests,
          },
        ],
      }),
    }),

    SystemModule,
    AuthModule,
    CostModule,
    SafetyModule,
    SimilarityModule,
    CharactersModule,
    ContentModule,
    AssetsModule,
    MediaModule,
    JobsModule,
    PipelineModule,
    YouTubeModule,
    VideosModule,
    AnalyticsModule,
    SchedulerModule,
    DashboardModule,
    WorkerModule,
  ],
  providers: [
    MaintenanceService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    {
      provide: APP_FILTER,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new AllExceptionsFilter(config),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route, including the probes and the internal endpoints.
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

export { loadAppConfig };
