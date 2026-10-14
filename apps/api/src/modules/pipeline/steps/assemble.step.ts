import { Injectable, Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { AssetsService } from '@/modules/assets/assets.service';
import { AssemblyService } from '@/modules/media/assembly.service';
import { SubtitleService } from '@/modules/media/subtitle.service';
import { IdeasService } from '@/modules/content/ideas.service';
import { ScriptsService } from '@/modules/content/scripts.service';
import { MetadataService } from '@/modules/content/metadata.service';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { SimilarityService } from '@/modules/similarity/similarity.service';
import { MediaProcessingError, ValidationError } from '@/common/errors';
import {
  type PipelineContext,
  type PipelineStep,
  type PipelineStepResult,
} from '../pipeline.types';

/**
 * GENERATED → QUALITY_CHECK (via ASSEMBLING).
 *
 * Downloads every scene, renders the final MP4, and produces the publishing
 * metadata. Metadata belongs here rather than in its own step because quality
 * control needs a title and description to check, and splitting them would mean
 * an extra state with nothing meaningful to show an operator.
 */
@Injectable()
export class AssembleStep implements PipelineStep {
  readonly from = VideoStatus.GENERATED;
  readonly running = VideoStatus.ASSEMBLING;
  readonly name = 'assemble';

  private readonly logger = new Logger(AssembleStep.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly assets: AssetsService,
    private readonly assembly: AssemblyService,
    private readonly subtitles: SubtitleService,
    private readonly ideas: IdeasService,
    private readonly scripts: ScriptsService,
    private readonly metadata: MetadataService,
    private readonly settings: SystemSettingsService,
    private readonly similarity: SimilarityService,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: context.videoId },
      include: {
        scenes: { orderBy: { index: 'asc' }, include: { asset: true } },
      },
    });

    const missing = video.scenes.filter((scene) => !scene.asset);
    if (missing.length > 0) {
      throw new ValidationError(
        `Cannot assemble: ${missing.length} scene(s) have no rendered asset.`,
      );
    }

    const subtitlesEnabled = video.subtitlesEnabled && (await this.settings.areSubtitlesEnabled());

    const workDir = await mkdtemp(join(tmpdir(), 'shorts-assemble-'));
    try {
      // Scenes live in object storage; ffmpeg needs local files.
      const scenePaths = await Promise.all(
        video.scenes.map(async (scene, index) => {
          const path = join(workDir, `scene-${String(index).padStart(3, '0')}.mp4`);
          await this.assets.downloadKeyToFile(scene.asset!.storageKey, path);
          return { path, durationSeconds: scene.durationSeconds };
        }),
      );

      const voiceAsset = await this.assets.findLatestForVideo(video.id, 'VOICEOVER');
      const voicePath = voiceAsset
        ? await this.assets.downloadKeyToFile(
            voiceAsset.storageKey,
            join(workDir, `voice${extensionOf(voiceAsset.storageKey)}`),
          )
        : null;

      const musicAsset = await this.assets.findLatestForVideo(video.id, 'MUSIC');
      const musicPath = musicAsset
        ? await this.assets.downloadKeyToFile(
            musicAsset.storageKey,
            join(workDir, `music${extensionOf(musicAsset.storageKey)}`),
          )
        : null;

      // Subtitles are timed from the scene plan, so they exist before the render.
      let subtitlePath: string | null = null;
      let cueCount = 0;
      if (subtitlesEnabled) {
        const cues = this.subtitles.buildCues(
          video.scenes.map((scene) => ({
            voiceover: scene.voiceover,
            durationSeconds: scene.durationSeconds,
          })),
        );
        cueCount = cues.length;

        if (cues.length > 0) {
          subtitlePath = join(workDir, 'captions.ass');
          await writeFile(subtitlePath, this.subtitles.renderAss(cues), 'utf8');
          await this.assets.storeBuffer(
            {
              videoId: video.id,
              kind: 'SUBTITLES',
              contentType: 'text/plain',
              sourceProvider: 'internal',
              sourceReference: 'subtitle-service',
              // Derived from our own narration, so provenance is ours.
              licenseStatus: 'DERIVED_OWN',
            },
            Buffer.from(this.subtitles.renderSrt(cues), 'utf8'),
            'captions.srt',
          );
        }
      }

      const outputPath = join(workDir, 'final.mp4');
      const result = await this.assembly.assemble({
        scenes: scenePaths,
        voiceoverPath: voicePath,
        musicPath,
        subtitlePath,
        outputPath,
        format: this.config.media.format,
      });

      const finalAsset = await this.assets.storeFile(
        {
          videoId: video.id,
          kind: 'FINAL_VIDEO',
          contentType: 'video/mp4',
          sourceProvider: 'internal',
          sourceReference: 'assembly-service',
          licenseStatus: 'DERIVED_OWN',
          durationSeconds: result.probe.durationSeconds,
        },
        outputPath,
        'final.mp4',
      );

      const metadata = await this.generateMetadata(video.id, video.ideaId, video.scriptId);

      await this.prisma.video.update({
        where: { id: video.id },
        data: {
          durationSeconds: result.probe.durationSeconds,
          width: result.probe.video?.width ?? null,
          height: result.probe.video?.height ?? null,
          fps: result.probe.video?.fps ? Math.round(result.probe.video.fps) : null,
          sizeBytes: result.probe.sizeBytes,
          subtitlesEnabled,
          ...(metadata
            ? {
                title: metadata.title,
                description: metadata.description,
                tags: metadata.tags,
                hashtags: metadata.hashtags,
                categoryId: this.config.youtube.defaultCategoryId,
              }
            : {}),
        },
      });

      if (metadata) {
        await this.similarity.store([
          { kind: 'VIDEO_TITLE', text: metadata.title, videoId: video.id },
        ]);
      }

      this.logger.log(
        `Assembled video ${video.id}: ${result.probe.durationSeconds.toFixed(1)}s, ` +
          `${(result.probe.sizeBytes / 1_048_576).toFixed(1)} MB, asset ${finalAsset.id}.`,
      );

      return {
        next: VideoStatus.QUALITY_CHECK,
        note: `Rendered ${result.probe.durationSeconds.toFixed(1)}s with ${cueCount} caption cues.`,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Metadata is only generated once; a retry reuses what already exists. */
  private async generateMetadata(videoId: string, ideaId: string | null, scriptId: string | null) {
    const existing = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { title: true, description: true },
    });
    if (existing?.title && existing.description) return null;

    if (!ideaId || !scriptId) {
      throw new MediaProcessingError('Cannot generate metadata without both an idea and a script.');
    }

    const [idea, script] = await Promise.all([
      this.ideas.toDraft(ideaId),
      this.scripts.toDraft(scriptId),
    ]);
    return this.metadata.generate(idea, script, videoId);
  }
}

function extensionOf(storageKey: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(storageKey);
  return match ? match[0] : '.bin';
}
