import { Module } from '@nestjs/common';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { PipelineModule } from '@/modules/pipeline/pipeline.module';
import { YouTubeModule } from '@/modules/youtube/youtube.module';
import { AnalyticsModule } from '@/modules/analytics/analytics.module';
import { ContentModule } from '@/modules/content/content.module';
import { SchedulerModule } from '@/modules/scheduler/scheduler.module';
import { SystemModule } from '@/modules/system/system.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { JobRunnerService } from './job-runner.service';
import { JobPollerService } from './job-poller.service';
import { InternalTasksController } from './internal-tasks.controller';

@Module({
  imports: [
    JobsModule,
    PipelineModule,
    YouTubeModule,
    AnalyticsModule,
    ContentModule,
    SchedulerModule,
    SystemModule,
    AuthModule,
  ],
  controllers: [InternalTasksController],
  providers: [JobRunnerService, JobPollerService],
  exports: [JobRunnerService],
})
export class WorkerModule {}
