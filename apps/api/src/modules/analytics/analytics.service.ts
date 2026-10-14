import { Inject, Injectable, Logger } from '@nestjs/common';
import { type AnalyticsOverview, type DerivedMetrics } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { YOUTUBE_PROVIDER } from '@/providers/provider.tokens';
import { type YouTubeProvider } from '@/providers/youtube/youtube-provider.interface';
import { ChannelsService } from '@/modules/youtube/channels.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { describeError } from '@/common/errors';
import { computeDerivedMetrics } from './metrics';

/**
 * Analytics collection.
 *
 * Snapshots are append-only: each sync writes a new row rather than updating the
 * last one. That is what makes trends computable at all, and it means a bad read
 * from the API is one anomalous point rather than corrupted history.
 *
 * Videos are batched per channel because the YouTube API takes up to 50 ids per
 * call — polling them one at a time would burn quota for no reason.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(YOUTUBE_PROVIDER) private readonly youtube: YouTubeProvider,
    private readonly channels: ChannelsService,
    private readonly systemLog: SystemLogService,
  ) {}

  /** Refreshes statistics for every published video on every connected channel. */
  async syncAll(): Promise<{ updated: number; failed: number }> {
    if (!this.config.analytics.syncEnabled) {
      this.logger.debug('Analytics sync is disabled by configuration.');
      return { updated: 0, failed: 0 };
    }

    const channels = await this.prisma.channel.findMany({
      where: { isActive: true, credential: { isNot: null } },
      select: { id: true, title: true },
    });

    let updated = 0;
    let failed = 0;

    for (const channel of channels) {
      try {
        updated += await this.syncChannel(channel.id);
      } catch (error) {
        failed += 1;
        await this.systemLog.error(
          'AnalyticsService',
          `Analytics sync failed for channel ${channel.title}.`,
          error,
        );
      }
    }

    return { updated, failed };
  }

  async syncChannel(channelId: string): Promise<number> {
    const videos = await this.prisma.video.findMany({
      where: { channelId, status: 'PUBLISHED', youtubeVideoId: { not: null } },
      select: { id: true, youtubeVideoId: true, publishedAt: true },
    });
    if (videos.length === 0) return 0;

    const accessToken = await this.channels.getAccessToken(channelId);
    const byYoutubeId = new Map(videos.map((video) => [video.youtubeVideoId as string, video]));

    let updated = 0;
    for (let offset = 0; offset < videos.length; offset += 50) {
      const batch = videos.slice(offset, offset + 50).map((v) => v.youtubeVideoId as string);
      const stats = await this.youtube.getVideoAnalytics(accessToken, batch);

      for (const stat of stats) {
        const video = byYoutubeId.get(stat.youtubeVideoId);
        if (!video) continue;

        const metrics = computeDerivedMetrics(
          { ...stat, capturedAt: new Date() },
          video.publishedAt ?? new Date(),
        );

        await this.prisma.$transaction([
          this.prisma.analyticsSnapshot.create({
            data: {
              videoId: video.id,
              views: stat.views,
              likes: stat.likes,
              comments: stat.comments,
              averageViewDurationSeconds: stat.averageViewDurationSeconds,
              viewsPerHour: metrics.viewsPerHour,
              likeRate: metrics.likeRate,
              commentRate: metrics.commentRate,
              performanceScore: metrics.performanceScore,
            },
          }),
          // The cached values on Video keep list views cheap; the snapshot table
          // remains the source of truth for history.
          this.prisma.video.update({
            where: { id: video.id },
            data: {
              views: stat.views,
              likes: stat.likes,
              comments: stat.comments,
              performanceScore: metrics.performanceScore,
            },
          }),
        ]);
        updated += 1;
      }
    }

    return updated;
  }

  /** Refreshes a single video, e.g. right after publication. */
  async syncVideo(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, channelId: true, youtubeVideoId: true, publishedAt: true },
    });
    if (!video?.channelId || !video.youtubeVideoId) return;

    try {
      const accessToken = await this.channels.getAccessToken(video.channelId);
      const [stat] = await this.youtube.getVideoAnalytics(accessToken, [video.youtubeVideoId]);
      if (!stat) return;

      const metrics = computeDerivedMetrics(
        { ...stat, capturedAt: new Date() },
        video.publishedAt ?? new Date(),
      );

      await this.prisma.$transaction([
        this.prisma.analyticsSnapshot.create({
          data: {
            videoId: video.id,
            views: stat.views,
            likes: stat.likes,
            comments: stat.comments,
            averageViewDurationSeconds: stat.averageViewDurationSeconds,
            viewsPerHour: metrics.viewsPerHour,
            likeRate: metrics.likeRate,
            commentRate: metrics.commentRate,
            performanceScore: metrics.performanceScore,
          },
        }),
        this.prisma.video.update({
          where: { id: video.id },
          data: {
            views: stat.views,
            likes: stat.likes,
            comments: stat.comments,
            performanceScore: metrics.performanceScore,
          },
        }),
      ]);
    } catch (error) {
      // Analytics are informational; a failure must never affect publishing.
      this.logger.warn(`Analytics sync failed for video ${videoId}: ${describeError(error)}`);
    }
  }

  async getMetricsForVideo(videoId: string): Promise<DerivedMetrics | null> {
    const [video, latest] = await Promise.all([
      this.prisma.video.findUnique({
        where: { id: videoId },
        select: { publishedAt: true },
      }),
      this.prisma.analyticsSnapshot.findFirst({
        where: { videoId },
        orderBy: { capturedAt: 'desc' },
      }),
    ]);

    if (!latest || !video?.publishedAt) return null;
    return computeDerivedMetrics(latest, video.publishedAt);
  }

  /** Channel-wide overview for the Analytics page. */
  async getOverview(
    days = 30,
  ): Promise<Omit<AnalyticsOverview, 'insights' | 'insightsGeneratedAt'>> {
    const since = new Date(Date.now() - days * 86_400_000);

    const [totals, published, snapshots, topVideos] = await Promise.all([
      this.prisma.video.aggregate({
        where: { status: 'PUBLISHED' },
        _sum: { views: true, likes: true, comments: true },
      }),
      this.prisma.video.count({ where: { status: 'PUBLISHED' } }),
      this.prisma.analyticsSnapshot.findMany({
        where: { capturedAt: { gte: since } },
        orderBy: { capturedAt: 'asc' },
        select: { capturedAt: true, views: true, likes: true, comments: true, videoId: true },
      }),
      this.prisma.video.findMany({
        where: { status: 'PUBLISHED' },
        orderBy: [{ performanceScore: 'desc' }, { views: 'desc' }],
        take: 10,
        include: { channel: { select: { title: true } } },
      }),
    ]);

    return {
      totals: {
        views: totals._sum.views ?? 0,
        likes: totals._sum.likes ?? 0,
        comments: totals._sum.comments ?? 0,
        published,
      },
      series: buildDailySeries(snapshots),
      topVideos: topVideos.map((video) => ({
        id: video.id,
        title: video.title,
        status: video.status,
        thumbnailUrl: null,
        previewUrl: null,
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
    };
  }

  /** Drops snapshots past the retention window. */
  async pruneSnapshots(): Promise<number> {
    const cutoff = new Date(Date.now() - this.config.analytics.retentionDays * 86_400_000);
    const result = await this.prisma.analyticsSnapshot.deleteMany({
      where: { capturedAt: { lt: cutoff } },
    });
    return result.count;
  }
}

/**
 * Collapses snapshots into one point per day.
 *
 * Snapshots are cumulative totals per video, so a day's figure is the sum of each
 * video's *latest* reading that day — not the sum of every reading, which would
 * multiply-count videos polled more than once.
 */
export function buildDailySeries(
  snapshots: Array<{
    capturedAt: Date;
    views: number;
    likes: number;
    comments: number;
    videoId: string;
  }>,
): Array<{ date: string; views: number; likes: number; comments: number }> {
  const perDay = new Map<string, Map<string, { views: number; likes: number; comments: number }>>();

  for (const snapshot of snapshots) {
    const date = snapshot.capturedAt.toISOString().slice(0, 10);
    let day = perDay.get(date);
    if (!day) {
      day = new Map();
      perDay.set(date, day);
    }
    // Later snapshots overwrite earlier ones for the same video and day.
    day.set(snapshot.videoId, {
      views: snapshot.views,
      likes: snapshot.likes,
      comments: snapshot.comments,
    });
  }

  return [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, videos]) => {
      let views = 0;
      let likes = 0;
      let comments = 0;
      for (const value of videos.values()) {
        views += value.views;
        likes += value.likes;
        comments += value.comments;
      }
      return { date, views, likes, comments };
    });
}
