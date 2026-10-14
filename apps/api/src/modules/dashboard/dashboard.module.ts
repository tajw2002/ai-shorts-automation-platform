import { Module } from '@nestjs/common';
import { CostModule } from '@/modules/cost/cost.module';
import { SystemModule } from '@/modules/system/system.module';
import { YouTubeModule } from '@/modules/youtube/youtube.module';
import { AssetsModule } from '@/modules/assets/assets.module';
import { AnalyticsModule } from '@/modules/analytics/analytics.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [CostModule, SystemModule, YouTubeModule, AssetsModule, AnalyticsModule, JobsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
