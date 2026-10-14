import { Injectable } from '@nestjs/common';
import { type DashboardStats, VideoStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { CostService } from '@/modules/cost/cost.service';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { PublishGuardService } from '@/modules/youtube/publish-guard.service';
import { AssetsService } from '@/modules/assets/assets.service';

/**
 * The dashboard's landing view.
 *
 * Every figure is gathered in one round of parallel queries rather than by the
 * page making a dozen requests, so the view is internally consistent — a caller
 * never sees "12 published" next to a top-videos list containing 13.
 */

/** Statuses that mean a video is actively moving through the pipeline. */
const IN_FLIGHT_STATUSES = [
  VideoStatus.CREATED,
  VideoStatus.SCRIPT_GENERATED,
  VideoStatus.SCENES_PLANNED,
  VideoStatus.GENERATING,
  VideoStatus.GENERATED,
  VideoStatus.ASSEMBLING,
  VideoStatus.QUALITY_CHECK,
  VideoStatus.QUEUED,
  VideoStatus.UPLOADING,
];

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cost: CostService,
    private readonly settings: SystemSettingsService,
    private readonly guard: PublishGuardService,
    private readonly assets: AssetsService,
  ) {}

  async getStats(): Promise<DashboardStats> {
    const since24h = new Date(Date.now() - 86_400_000);
    const quotas = await this.settings.getUploadQuotas();

    const [
      videosGenerated,
      videosPublished,
      videosInQueue,
      videosAwaitingReview,
      failedJobs24h,
      quota,
      totals,
      avgDuration,
      topVideos,
      recentErrors,
      costSummary,
      operational,
      approvalMode,
    ] = await Promise.all([
      this.prisma.video.count({
        where: { status: { notIn: [VideoStatus.CREATED, VideoStatus.CANCELLED] } },
      }),
      this.prisma.video.count({ where: { status: VideoStatus.PUBLISHED } }),
      this.prisma.video.count({ where: { status: { in: IN_FLIGHT_STATUSES } } }),
      this.prisma.video.count({ where: { status: VideoStatus.READY_FOR_REVIEW } }),
      this.prisma.job.count({
        where: { status: { in: ['FAILED', 'DEAD_LETTER'] }, createdAt: { gte: since24h } },
      }),
      this.guard.getQuotaUsage(quotas),
      this.prisma.video.aggregate({
        where: { status: VideoStatus.PUBLISHED },
        _sum: { views: true, likes: true, comments: true },
      }),
      this.prisma.analyticsSnapshot.aggregate({
        _avg: { averageViewDurationSeconds: true },
      }),
      this.prisma.video.findMany({
        where: { status: VideoStatus.PUBLISHED },
        orderBy: [{ performanceScore: 'desc' }, { views: 'desc' }],
        take: 5,
        include: { channel: { select: { title: true } } },
      }),
      this.prisma.systemLog.findMany({
        where: { level: { in: ['ERROR', 'FATAL'] } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, createdAt: true, service: true, message: true, videoId: true },
      }),
      this.cost.getSummary(),
      this.settings.getOperationalState(),
      this.settings.getApprovalMode(),
    ]);

    return {
      videosGenerated,
      videosPublished,
      videosInQueue,
      videosAwaitingReview,
      failedJobs24h,
      uploadsToday: quota.usedToday,
      uploadsRemainingToday: Math.max(0, quota.dailyLimit - quota.usedToday),
      totalViews: totals._sum.views ?? 0,
      totalLikes: totals._sum.likes ?? 0,
      totalComments: totals._sum.comments ?? 0,
      averageViewDurationSeconds: avgDuration._avg.averageViewDurationSeconds ?? null,
      cost: costSummary,
      operational: {
        emergencyStop: operational.emergencyStop,
        generationPaused: operational.generationPaused,
        uploadsPaused: operational.uploadsPaused,
        autoPublish: operational.autoPublish,
        requireApproval: operational.requireApproval,
        dryRun: operational.dryRun,
        approvalMode,
      },
      topVideos: await Promise.all(
        topVideos.map(async (video) => ({
          id: video.id,
          title: video.title,
          status: video.status,
          thumbnailUrl: null,
          previewUrl: await this.previewUrl(video.id),
          durationSeconds: video.durationSeconds,
          channelName: video.channel?.title ?? null,
          youtubeVideoId: video.youtubeVideoId,
          youtubeUrl: video.youtubeUrl,
          privacyStatus: video.privacyStatus,
          createdAt: video.createdAt.toISOString(),
          scheduledAt: video.scheduledAt?.toISOString() ?? null,
          publishedAt: video.publishedAt?.toISOString() ?? null,
          views: video.views,
          likes: video.likes,
          comments: video.comments,
          performanceScore: video.performanceScore,
          lastError: video.lastError,
        })),
      ),
      recentErrors: recentErrors.map((log) => ({
        id: log.id,
        at: log.createdAt.toISOString(),
        service: log.service,
        message: log.message,
        videoId: log.videoId,
      })),
    };
  }

  private async previewUrl(videoId: string): Promise<string | null> {
    const asset = await this.assets.findLatestForVideo(videoId, 'FINAL_VIDEO');
    if (!asset) return null;
    return this.assets.getPreviewUrlForKey(asset.storageKey).catch(() => null);
  }
}
