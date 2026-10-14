import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { listJobsSchema, type ListJobsDto } from '@shorts/contracts';
import { zodQuery } from '@/common/pipes/zod-validation.pipe';
import { JobsService } from '@/modules/jobs/jobs.service';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { PerformanceAnalysisService } from '@/modules/analytics/performance-analysis.service';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller()
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly jobs: JobsService,
    private readonly analytics: AnalyticsService,
    private readonly performance: PerformanceAnalysisService,
  ) {}

  @Get('dashboard')
  getDashboard() {
    return this.dashboard.getStats();
  }

  @Get('jobs')
  listJobs(@Query(zodQuery(listJobsSchema)) query: ListJobsDto) {
    return this.jobs.list(query, {
      status: query.status,
      type: query.type,
      videoId: query.videoId,
    });
  }

  @Get('analytics')
  async getAnalytics(@Query('days') days?: string) {
    const window = Math.min(365, Math.max(1, Number(days) || 30));
    const [overview, insights, generatedAt] = await Promise.all([
      this.analytics.getOverview(window),
      this.performance.getActiveInsights(),
      this.performance.getLatestGeneratedAt(),
    ]);

    return {
      ...overview,
      insights: insights.map((insight) => ({
        dimension: insight.dimension,
        observation: insight.observation,
        recommendation: insight.recommendation,
        confidence: insight.confidence,
        sampleVideoIds: insight.sampleVideoIds,
      })),
      insightsGeneratedAt: generatedAt,
    };
  }
}
