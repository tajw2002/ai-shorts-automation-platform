import { Injectable } from '@nestjs/common';
import {
  type CreateVideoDto,
  type ListVideosDto,
  type Paginated,
  type QualityReport,
  type RegenerateVideoDto,
  type UpdateVideoMetadataDto,
  type VideoDetail,
  type VideoStatus,
  VideoStatus as Status,
  type VideoSummary,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { PipelineOrchestrator } from '@/modules/pipeline/pipeline.orchestrator';
import { AssetsService } from '@/modules/assets/assets.service';
import { AnalyticsService } from '@/modules/analytics/analytics.service';
import { AuditService } from '@/modules/system/audit.service';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { ConflictError, NotFoundError, ValidationError } from '@/common/errors';
import { normalizeHashtag, uniqueBy } from '@/common/utils/text';

/**
 * Video CRUD and the operator actions around it.
 *
 * The review workflow lives here: approve, reject, regenerate. Each one is a
 * deliberate state transition through the orchestrator, so nothing bypasses the
 * audit trail — "who approved this" must always have an answer.
 */
@Injectable()
export class VideosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly pipeline: PipelineOrchestrator,
    private readonly assets: AssetsService,
    private readonly analytics: AnalyticsService,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
  ) {}

  async create(dto: CreateVideoDto, actorId?: string): Promise<{ id: string }> {
    const idea = await this.prisma.contentIdea.findUnique({ where: { id: dto.ideaId } });
    if (!idea) throw new NotFoundError('Idea', dto.ideaId);
    if (idea.safetyVerdict === 'BLOCK') {
      throw new ConflictError('This idea was blocked by the safety layer and cannot be produced.');
    }

    const channelId =
      dto.channelId ??
      (
        await this.prisma.channel.findFirst({
          where: { isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      )?.id ??
      null;

    const video = await this.prisma.video.create({
      data: {
        ideaId: idea.id,
        channelId,
        status: Status.CREATED,
        title: idea.title,
        privacyStatus: await this.settings.getDefaultPrivacyStatus(),
        subtitlesEnabled: dto.subtitlesEnabled ?? this.config.media.subtitlesEnabled,
        madeForKids: this.config.youtube.madeForKids,
        categoryId: this.config.youtube.defaultCategoryId,
      },
    });

    await this.prisma.videoStatusEvent.create({
      data: {
        videoId: video.id,
        from: null,
        to: Status.CREATED,
        note: 'Video created.',
        actorId: actorId ?? null,
      },
    });

    await this.pipeline.start(video.id);

    await this.audit.record({
      userId: actorId ?? null,
      action: 'video.create',
      entityType: 'Video',
      entityId: video.id,
      metadata: { ideaId: idea.id },
    });

    return { id: video.id };
  }

  async list(dto: ListVideosDto): Promise<Paginated<VideoSummary>> {
    const where = {
      ...(dto.status ? { status: dto.status as VideoStatus } : {}),
      ...(dto.channelId ? { channelId: dto.channelId } : {}),
      ...(dto.search
        ? {
            OR: [
              { title: { contains: dto.search, mode: 'insensitive' as const } },
              { description: { contains: dto.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const orderBy =
      dto.sort === 'views'
        ? { views: dto.direction }
        : dto.sort === 'performanceScore'
          ? { performanceScore: dto.direction }
          : dto.sort === 'publishedAt'
            ? { publishedAt: dto.direction }
            : { createdAt: dto.direction };

    const [rows, total] = await Promise.all([
      this.prisma.video.findMany({
        where,
        orderBy,
        skip: (dto.page - 1) * dto.pageSize,
        take: dto.pageSize,
        include: { channel: { select: { title: true } } },
      }),
      this.prisma.video.count({ where }),
    ]);

    const items = await Promise.all(rows.map((row) => this.toSummary(row)));

    return {
      items,
      page: dto.page,
      pageSize: dto.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / dto.pageSize)),
    };
  }

  async findDetail(id: string): Promise<VideoDetail> {
    const video = await this.prisma.video.findUnique({
      where: { id },
      include: {
        channel: { select: { title: true } },
        script: { select: { narration: true } },
        scenes: { orderBy: { index: 'asc' }, include: { asset: true } },
        qualityReports: { orderBy: { createdAt: 'desc' }, take: 1 },
        statusEvents: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!video) throw new NotFoundError('Video', id);

    const summary = await this.toSummary(video);
    const report = video.qualityReports[0];

    const scenes = await Promise.all(
      video.scenes.map(async (scene) => ({
        id: scene.id,
        index: scene.index,
        prompt: scene.prompt,
        voiceover: scene.voiceover,
        durationSeconds: scene.durationSeconds,
        status: scene.status,
        assetUrl: scene.asset
          ? await this.assets.getPreviewUrlForKey(scene.asset.storageKey).catch(() => null)
          : null,
      })),
    );

    return {
      ...summary,
      description: video.description,
      tags: video.tags,
      hashtags: video.hashtags,
      ideaId: video.ideaId,
      scriptId: video.scriptId,
      narration: video.script?.narration ?? null,
      scenes,
      qualityReport: report
        ? ({
            passed: report.passed,
            failureCount: report.failureCount,
            warningCount: report.warningCount,
            // Prisma types a Json column as JsonValue; the shape is guaranteed
            // by QualityControlService, which is the only writer.
            checks: report.checks as unknown as QualityReport['checks'],
            evaluatedAt: report.createdAt.toISOString(),
          } satisfies QualityReport)
        : null,
      safetyVerdict: video.safetyVerdict,
      metrics: await this.analytics.getMetricsForVideo(video.id),
      costMicros: video.costMicros,
      statusHistory: video.statusEvents.map((event) => ({
        status: event.to,
        at: event.createdAt.toISOString(),
        note: event.note,
      })),
    };
  }

  /**
   * Approve or reject a video awaiting review.
   *
   * Only valid from READY_FOR_REVIEW: approving something still rendering, or
   * already published, is a mistake worth refusing rather than silently ignoring.
   */
  async review(
    id: string,
    decision: 'approve' | 'reject',
    note: string | undefined,
    actorId: string,
  ): Promise<{ status: VideoStatus }> {
    const video = await this.prisma.video.findUnique({ where: { id } });
    if (!video) throw new NotFoundError('Video', id);

    if (video.status !== Status.READY_FOR_REVIEW) {
      throw new ConflictError(
        `Only a video awaiting review can be ${decision}d; this one is ${video.status}.`,
      );
    }

    if (decision === 'approve') {
      await this.prisma.video.update({
        where: { id },
        data: { approvedAt: new Date(), approvedById: actorId },
      });
      await this.pipeline.transition(id, Status.APPROVED, note ?? 'Approved by operator.', actorId);
    } else {
      await this.pipeline.transition(id, Status.REJECTED, note ?? 'Rejected by operator.', actorId);
    }

    await this.audit.record({
      userId: actorId,
      action: `video.${decision}`,
      entityType: 'Video',
      entityId: id,
      metadata: { note: note ?? null },
    });

    return { status: decision === 'approve' ? Status.APPROVED : Status.REJECTED };
  }

  /**
   * Rewinds a video to an earlier stage and re-runs from there.
   *
   * Rewinding deletes the downstream artefacts it invalidates — regenerating
   * scenes while keeping the old render would leave a video whose file no longer
   * matches its scene list.
   */
  async regenerate(id: string, dto: RegenerateVideoDto, actorId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({ where: { id } });
    if (!video) throw new NotFoundError('Video', id);

    if (video.status === Status.PUBLISHED) {
      throw new ConflictError('A published video cannot be regenerated. Create a new one instead.');
    }

    const target = REGENERATION_TARGETS[dto.from];
    if (!target) throw new ValidationError(`Unknown regeneration stage '${dto.from}'.`);

    await this.prisma.$transaction(async (tx) => {
      if (target.clearScenes) {
        await tx.videoScene.deleteMany({ where: { videoId: id } });
      }
      if (target.clearAssetKinds.length > 0) {
        await tx.asset.deleteMany({
          where: { videoId: id, kind: { in: target.clearAssetKinds } },
        });
      }
      if (target.clearScript) {
        await tx.video.update({ where: { id }, data: { scriptId: null } });
      }
      if (target.clearMetadata) {
        await tx.video.update({ where: { id }, data: { title: null, description: null } });
      }
      await tx.video.update({
        where: { id },
        data: { lastError: null, approvedAt: null, approvedById: null },
      });
    });

    await this.pipeline.transition(
      id,
      target.status,
      dto.reason ?? `Regenerating from ${dto.from}.`,
      actorId,
    );
    await this.pipeline.start(id);

    await this.audit.record({
      userId: actorId,
      action: 'video.regenerate',
      entityType: 'Video',
      entityId: id,
      metadata: { from: dto.from, reason: dto.reason ?? null },
    });
  }

  async updateMetadata(id: string, dto: UpdateVideoMetadataDto, actorId: string) {
    const video = await this.prisma.video.findUnique({ where: { id } });
    if (!video) throw new NotFoundError('Video', id);

    const hashtags = dto.hashtags
      ? uniqueBy(dto.hashtags.map(normalizeHashtag).filter(Boolean), (tag) => tag)
      : undefined;

    const updated = await this.prisma.video.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
        ...(hashtags !== undefined ? { hashtags } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
      },
    });

    await this.audit.record({
      userId: actorId,
      action: 'video.update_metadata',
      entityType: 'Video',
      entityId: id,
    });

    return updated;
  }

  async cancel(id: string, actorId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({ where: { id } });
    if (!video) throw new NotFoundError('Video', id);
    if (video.status === Status.PUBLISHED) {
      throw new ConflictError('A published video cannot be cancelled.');
    }

    await this.pipeline.transition(id, Status.CANCELLED, 'Cancelled by operator.', actorId);
    await this.audit.record({
      userId: actorId,
      action: 'video.cancel',
      entityType: 'Video',
      entityId: id,
    });
  }

  async remove(id: string, actorId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({ where: { id } });
    if (!video) throw new NotFoundError('Video', id);
    if (video.status === Status.PUBLISHED) {
      throw new ConflictError(
        'A published video cannot be deleted here; remove it on YouTube first.',
      );
    }

    // Storage objects go first: a deleted row would orphan them permanently.
    const assets = await this.assets.findForVideo(id);
    for (const asset of assets) {
      await this.assets.remove(asset.id).catch(() => undefined);
    }

    await this.prisma.video.delete({ where: { id } });
    await this.audit.record({
      userId: actorId,
      action: 'video.delete',
      entityType: 'Video',
      entityId: id,
    });
  }

  /** Videos waiting on a human, for the review queue. */
  async listAwaitingReview(limit = 50) {
    return this.prisma.video.findMany({
      where: { status: Status.READY_FOR_REVIEW },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { channel: { select: { title: true } } },
    });
  }

  private async toSummary(video: {
    id: string;
    title: string | null;
    status: VideoStatus;
    durationSeconds: number | null;
    youtubeVideoId: string | null;
    youtubeUrl: string | null;
    privacyStatus: VideoSummary['privacyStatus'];
    createdAt: Date;
    scheduledAt: Date | null;
    publishedAt: Date | null;
    views: number;
    likes: number;
    comments: number;
    performanceScore: number | null;
    lastError: string | null;
    channel?: { title: string } | null;
  }): Promise<VideoSummary> {
    const finalAsset = await this.assets.findLatestForVideo(video.id, 'FINAL_VIDEO');
    const previewUrl = finalAsset
      ? await this.assets.getPreviewUrlForKey(finalAsset.storageKey).catch(() => null)
      : null;

    return {
      id: video.id,
      title: video.title,
      status: video.status,
      thumbnailUrl: null,
      previewUrl,
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
    };
  }
}

/**
 * What each rewind point invalidates.
 *
 * Declared as data rather than a switch so the invalidation rules are visible
 * side by side — it is easy to see that regenerating scenes must also drop the
 * final render, and hard to forget one.
 */
const REGENERATION_TARGETS: Record<
  RegenerateVideoDto['from'],
  {
    status: VideoStatus;
    clearScript: boolean;
    clearScenes: boolean;
    clearMetadata: boolean;
    clearAssetKinds: Array<'SCENE_VIDEO' | 'VOICEOVER' | 'SUBTITLES' | 'FINAL_VIDEO'>;
  }
> = {
  script: {
    status: Status.CREATED,
    clearScript: true,
    clearScenes: true,
    clearMetadata: true,
    clearAssetKinds: ['SCENE_VIDEO', 'VOICEOVER', 'SUBTITLES', 'FINAL_VIDEO'],
  },
  scenes: {
    status: Status.SCRIPT_GENERATED,
    clearScript: false,
    clearScenes: true,
    clearMetadata: false,
    clearAssetKinds: ['SCENE_VIDEO', 'VOICEOVER', 'SUBTITLES', 'FINAL_VIDEO'],
  },
  video: {
    status: Status.SCENES_PLANNED,
    clearScript: false,
    clearScenes: false,
    clearMetadata: false,
    clearAssetKinds: ['SCENE_VIDEO', 'FINAL_VIDEO'],
  },
  voice: {
    status: Status.GENERATED,
    clearScript: false,
    clearScenes: false,
    clearMetadata: false,
    clearAssetKinds: ['VOICEOVER', 'FINAL_VIDEO'],
  },
  assembly: {
    status: Status.GENERATED,
    clearScript: false,
    clearScenes: false,
    clearMetadata: false,
    clearAssetKinds: ['FINAL_VIDEO'],
  },
  metadata: {
    status: Status.GENERATED,
    clearScript: false,
    clearScenes: false,
    clearMetadata: true,
    clearAssetKinds: ['FINAL_VIDEO'],
  },
};

export { REGENERATION_TARGETS };
