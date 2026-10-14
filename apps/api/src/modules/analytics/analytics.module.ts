import { Module } from '@nestjs/common';
import { YouTubeModule } from '@/modules/youtube/youtube.module';
import { CostModule } from '@/modules/cost/cost.module';
import { SystemModule } from '@/modules/system/system.module';
import { AnalyticsService } from './analytics.service';
import { PerformanceAnalysisService } from './performance-analysis.service';

@Module({
  imports: [YouTubeModule, CostModule, SystemModule],
  providers: [AnalyticsService, PerformanceAnalysisService],
  exports: [AnalyticsService, PerformanceAnalysisService],
})
export class AnalyticsModule {}
