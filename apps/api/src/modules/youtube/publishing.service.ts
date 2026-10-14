import { Inject, Injectable } from '@nestjs/common';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobType, type PrivacyStatus, VideoStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { YOUTUBE_PROVIDER } from '@/providers/provider.tokens';
import { type YouTubeProvider } from '@/providers/youtube/youtube-provider.interface';
import { AssetsService } from '@/modules/assets/assets.service';
import { JobsService } from '@/modules/jobs/jobs.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { AuditService } from '@/modules/system/audit.service';
import { PipelineOrchestrator } from '@/modules/pipeline/pipeline.orchestrator';
import { ChannelsService } from './channels.service';
import { PublishGuardService } from './publish-guard.service';
import {
  ConflictError,
  describeError,
  NotFoundError,
  UploadFailedError,
  ValidationError,
} from '@/common/errors';

/**
 * Publishing.
 *
 * `schedule()` records intent and enqueues a job; `execute()` performs the upload.
 * They are separate because publishing must survive a restart: the intent is
 * durable state, and the upload itself is resumable from the stored session URL.
 *
 * The guard is evaluated twice — once when scheduling, and again immediately
 * before the bytes are sent. The second check matters: an emergency stop pressed
 * while a job sat in the queue must still prevent the upload.
 */
@Injectable()
export class PublishingService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(YOUTUBE_PROVIDER) private readonly youtube: YouTubeProvider,
    private readonly channels: ChannelsService,
    private readonly guard: PublishGuardService,
    private readonly assets: AssetsService,
    private readonly jobs: JobsService,
    private readonly pipeline: PipelineOrchestrator,
    private readonly systemLog: SystemLogService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Queues a video for publication.
   *
   * `publishAt` in the future means YouTube holds it private and flips it public
   * itself — more reliable than us waking up at the right moment.
   */
  async schedule(
    videoId: string,
    options: {
      channelId?: string;
      publishAt?: Date | null;
      privacyStatus?: PrivacyStatus;
      actorId?: string;
    } = {},
  ): Promise<{ uploadJobId: string; jobId: string; runAfter: Date }> {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video) throw new NotFoundError('Video', videoId);

    const channel = options.channelId
      ? await this.channels.findById(options.channelId)
      : video.channelId
        ? await this.channels.findById(video.channelId)
        : await this.channels.getDefaultChannel();

    if (options.publishAt && options.publishAt.getTime() <= Date.now()) {
      throw new ValidationError('A scheduled publish time must be in the future.');
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        channelId: channel.id,
        scheduledAt: options.publishAt ?? null,
        privacyStatus: options.privacyStatus ?? video.privacyStatus,
      },
    });

    const decision = await this.guard.evaluate(videoId);
    if (!decision.allowed) {
      throw new ConflictError('This video cannot be published yet.', {
        blockers: decision.blockers,
      });
    }

    const uploadJob = await this.prisma.uploadJob.create({
      data: {
        videoId,
        channelId: channel.id,
        status: 'PENDING',
        privacyStatus: decision.effectivePrivacyStatus,
        publishAt: options.publishAt ?? null,
        simulated: decision.simulated,
      },
    });

    // Upload immediately; YouTube itself honours publishAt. Waiting locally would
    // add a failure mode for no benefit.
    const runAfter = new Date();

    const jobId = await this.jobs.enqueue({
      type: JobType.UPLOAD,
      videoId,
      payload: { videoId, uploadJobId: uploadJob.id },
      idempotencyParts: [JobType.UPLOAD, uploadJob.id],
      runAfter,
      priority: 10,
    });

    await this.pipeline.transition(
      videoId,
      VideoStatus.QUEUED,
      options.publishAt
        ? `Queued for upload; YouTube will publish at ${options.publishAt.toISOString()}.`
        : 'Queued for upload.',
      options.actorId ?? null,
    );

    await this.audit.record({
      userId: options.actorId ?? null,
      action: 'video.schedule_publish',
      entityType: 'Video',
      entityId: videoId,
      metadata: {
        channelId: channel.id,
        publishAt: options.publishAt?.toISOString() ?? null,
        privacyStatus: decision.effectivePrivacyStatus,
      },
    });

    return { uploadJobId: uploadJob.id, jobId, runAfter };
  }

  /**
   * Performs the upload.
   *
   * Progress is persisted as it goes so a failed attempt can resume from the
   * stored session URL rather than re-sending the whole file.
   */
  async execute(uploadJobId: string): Promise<{ youtubeVideoId: string; url: string }> {
    const uploadJob = await this.prisma.uploadJob.findUnique({
      where: { id: uploadJobId },
      include: { video: true },
    });
    if (!uploadJob) throw new NotFoundError('Upload job', uploadJobId);

    if (uploadJob.status === 'COMPLETED' && uploadJob.youtubeVideoId) {
      // A duplicate delivery of a job that already succeeded.
      return {
        youtubeVideoId: uploadJob.youtubeVideoId,
        url: `https://www.youtube.com/shorts/${uploadJob.youtubeVideoId}`,
      };
    }

    // Re-check: the world may have changed while this sat in the queue.
    const decision = await this.guard.evaluate(uploadJob.videoId);
    if (!decision.allowed) {
      await this.markUploadFailed(uploadJobId, decision.blockers.join(' '));
      throw new ConflictError('Publishing is currently blocked.', {
        blockers: decision.blockers,
      });
    }

    const video = uploadJob.video;
    const finalAsset = await this.assets.findLatestForVideo(video.id, 'FINAL_VIDEO');
    if (!finalAsset) {
      await this.markUploadFailed(uploadJobId, 'No rendered video asset was found.');
      throw new UploadFailedError('No rendered video asset was found.', false);
    }

    const accessToken = await this.channels.getAccessToken(uploadJob.channelId);
    const channel = await this.channels.findById(uploadJob.channelId);

    const workDir = await mkdtemp(join(tmpdir(), 'shorts-upload-'));
    try {
      await this.prisma.uploadJob.update({
        where: { id: uploadJobId },
        data: { status: 'UPLOADING', startedAt: new Date(), attempts: { increment: 1 } },
      });
      await this.pipeline.transition(video.id, VideoStatus.UPLOADING, 'Upload started.');

      const localPath = join(workDir, 'upload.mp4');
      await this.assets.downloadKeyToFile(finalAsset.storageKey, localPath);
      const sizeBytes = (await stat(localPath)).size;

      const result = await this.youtube.uploadVideo({
        accessToken,
        filePath: localPath,
        sizeBytes,
        metadata: {
          title: video.title ?? 'Untitled',
          description: video.description ?? '',
          tags: video.tags,
          categoryId: video.categoryId ?? channel.defaultCategoryId,
          privacyStatus: decision.effectivePrivacyStatus,
          publishAt: uploadJob.publishAt,
          madeForKids: video.madeForKids || channel.madeForKids,
          // AI-generated material is declared, not hidden.
          containsSyntheticMedia: true,
        },
        resumeSessionUrl: uploadJob.resumableSessionUrl ?? undefined,
        onProgress: (bytesUploaded, sessionUrl) => {
          // Fire-and-forget: progress reporting must not slow the transfer or
          // fail the upload if a write briefly errors.
          void this.prisma.uploadJob
            .update({
              where: { id: uploadJobId },
              data: { bytesUploaded, bytesTotal: sizeBytes, resumableSessionUrl: sessionUrl },
            })
            .catch(() => undefined);
        },
      });

      await this.prisma.$transaction([
        this.prisma.uploadJob.update({
          where: { id: uploadJobId },
          data: {
            status: 'COMPLETED',
            youtubeVideoId: result.youtubeVideoId,
            bytesUploaded: sizeBytes,
            bytesTotal: sizeBytes,
            finishedAt: new Date(),
            errorMessage: null,
            simulated: result.simulated,
          },
        }),
        this.prisma.video.update({
          where: { id: video.id },
          data: {
            youtubeVideoId: result.youtubeVideoId,
            youtubeUrl: result.url,
            privacyStatus: result.privacyStatus,
            publishedAt: uploadJob.publishAt ?? new Date(),
          },
        }),
      ]);

      await this.pipeline.transition(
        video.id,
        VideoStatus.PUBLISHED,
        result.simulated
          ? `Simulated upload (DRY_RUN) as ${result.youtubeVideoId}.`
          : `Uploaded as ${result.youtubeVideoId}.`,
      );

      await this.prisma.contentIdea
        .updateMany({ where: { id: video.ideaId ?? '' }, data: { status: 'USED' } })
        .catch(() => undefined);

      await this.systemLog.info(
        'PublishingService',
        `Published video ${video.id} as ${result.youtubeVideoId}${result.simulated ? ' (simulated)' : ''}.`,
        { videoId: video.id },
      );

      // Start collecting analytics from now on.
      await this.jobs
        .enqueue({
          type: JobType.ANALYTICS_SYNC,
          videoId: video.id,
          payload: { videoId: video.id },
          idempotencyParts: [
            JobType.ANALYTICS_SYNC,
            video.id,
            new Date().toISOString().slice(0, 13),
          ],
          runAfter: new Date(Date.now() + 3_600_000),
        })
        .catch(() => undefined);

      return { youtubeVideoId: result.youtubeVideoId, url: result.url };
    } catch (error) {
      await this.markUploadFailed(uploadJobId, describeError(error));
      await this.systemLog.error(
        'PublishingService',
        `Upload failed for video ${uploadJob.videoId}.`,
        error,
        { videoId: uploadJob.videoId },
      );
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Cancels a pending publication and returns the video to APPROVED. */
  async cancel(videoId: string, actorId?: string): Promise<void> {
    const pending = await this.prisma.uploadJob.findMany({
      where: { videoId, status: { in: ['PENDING', 'UPLOADING'] } },
    });

    for (const job of pending) {
      await this.prisma.uploadJob.update({
        where: { id: job.id },
        data: {
          status: 'CANCELLED',
          finishedAt: new Date(),
          errorMessage: 'Cancelled by operator.',
        },
      });
    }

    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (video && (video.status === VideoStatus.QUEUED || video.status === VideoStatus.UPLOADING)) {
      await this.pipeline.transition(
        videoId,
        VideoStatus.APPROVED,
        'Publication cancelled by operator.',
        actorId ?? null,
      );
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: { scheduledAt: null },
    });

    await this.audit.record({
      userId: actorId ?? null,
      action: 'video.cancel_publish',
      entityType: 'Video',
      entityId: videoId,
    });
  }

  /** Updates metadata on an already-published video. */
  async updatePublishedMetadata(
    videoId: string,
    metadata: { title?: string; description?: string; tags?: string[] },
  ): Promise<void> {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video?.youtubeVideoId || !video.channelId) {
      throw new ConflictError('This video has not been published to YouTube.');
    }

    const accessToken = await this.channels.getAccessToken(video.channelId);
    await this.youtube.updateVideo(accessToken, video.youtubeVideoId, metadata);

    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        ...(metadata.title ? { title: metadata.title } : {}),
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(metadata.tags ? { tags: metadata.tags } : {}),
      },
    });
  }

  private async markUploadFailed(uploadJobId: string, reason: string): Promise<void> {
    await this.prisma.uploadJob
      .update({
        where: { id: uploadJobId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage: reason.slice(0, 2000),
        },
      })
      .catch(() => undefined);
  }
}
