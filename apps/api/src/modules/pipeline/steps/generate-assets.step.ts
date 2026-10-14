import { Inject, Injectable, Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usdToMicros, VideoStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { VIDEO_PROVIDER, VOICE_PROVIDER } from '@/providers/provider.tokens';
import { type VideoProvider } from '@/providers/video/video-provider.interface';
import { type VoiceProvider } from '@/providers/voice/voice-provider.interface';
import { AssetsService } from '@/modules/assets/assets.service';
import { MeteredExecutor } from '@/modules/cost/metered-executor.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { pollUntil } from '@/common/resilience/retry';
import { clampClipSeconds } from '@/common/utils/clip';
import { alignSceneDurations } from '@/common/utils/scene-timing';
import { FfmpegRunner } from '@/infrastructure/ffmpeg/ffmpeg.runner';
import { describeError, ProviderError } from '@/common/errors';
import {
  type PipelineContext,
  type PipelineStep,
  type PipelineStepResult,
} from '../pipeline.types';

/**
 * SCENES_PLANNED → GENERATED (via GENERATING).
 *
 * The expensive step: every scene clip plus the voiceover. Three properties make
 * it safe to retry, which matters because this is also the step most likely to
 * fail halfway through:
 *
 *  1. A scene that already has an asset is skipped entirely.
 *  2. The provider job id is persisted before polling starts, so a worker restart
 *     resumes polling instead of paying to generate the same scene again.
 *  3. Concurrency is bounded by `MAX_CONCURRENT_GENERATIONS`, so a ten-scene
 *     video cannot open ten simultaneous paid requests.
 */
@Injectable()
export class GenerateAssetsStep implements PipelineStep {
  readonly from = VideoStatus.SCENES_PLANNED;
  readonly running = VideoStatus.GENERATING;
  readonly name = 'generate-assets';

  private readonly logger = new Logger(GenerateAssetsStep.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(VIDEO_PROVIDER) private readonly video: VideoProvider,
    @Inject(VOICE_PROVIDER) private readonly voice: VoiceProvider,
    private readonly assets: AssetsService,
    private readonly metered: MeteredExecutor,
    private readonly systemLog: SystemLogService,
    private readonly ffmpeg: FfmpegRunner,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: context.videoId },
      include: { scenes: { orderBy: { index: 'asc' } } },
    });

    if (video.scenes.length === 0) {
      throw new ProviderError({
        provider: this.video.name,
        message: 'The video has no scenes to generate.',
      });
    }

    const generationJob = await this.prisma.generationJob.create({
      data: {
        videoId: video.id,
        status: 'RUNNING',
        provider: this.video.name,
        scenesTotal: video.scenes.length,
        startedAt: new Date(),
      },
    });

    const workDir = await mkdtemp(join(tmpdir(), 'shorts-scenes-'));
    let completed = 0;
    let failed = 0;

    try {
      // The voice comes first: its measured length decides how long each scene is
      // on screen, and so how many clip seconds are worth paying for.
      const narrationSeconds = await this.generateVoiceover(video.id, context.jobId, workDir);
      const scenes = await this.alignScenesToNarration(video.scenes, narrationSeconds);

      const pending = scenes.filter((scene) => scene.assetId === null);
      completed = scenes.length - pending.length;

      // A small bounded pool: enough to hide provider latency, not so much that a
      // single video saturates the budget or the provider's rate limit.
      const concurrency = Math.max(1, this.config.quotas.maxConcurrentGenerations);
      for (let offset = 0; offset < pending.length; offset += concurrency) {
        const batch = pending.slice(offset, offset + concurrency);
        const results = await Promise.allSettled(
          batch.map((scene) => this.generateScene(video.id, scene, context.jobId)),
        );

        for (const [index, result] of results.entries()) {
          if (result.status === 'fulfilled') {
            completed += 1;
          } else {
            failed += 1;
            const scene = batch[index]!;
            await this.prisma.videoScene.update({
              where: { id: scene.id },
              data: {
                status: 'FAILED',
                attempts: { increment: 1 },
                errorMessage: describeError(result.reason).slice(0, 1000),
              },
            });
            await this.systemLog.error(
              'GenerateAssetsStep',
              `Scene ${scene.index} failed to generate.`,
              result.reason,
              { videoId: video.id, jobId: context.jobId },
            );
          }
        }
      }

      // Partial success is not success: assembling a video with a hole in it
      // wastes the render and produces something no one would publish.
      if (failed > 0) {
        await this.prisma.generationJob.update({
          where: { id: generationJob.id },
          data: {
            status: 'PARTIAL',
            scenesCompleted: completed,
            scenesFailed: failed,
            finishedAt: new Date(),
            errorMessage: `${failed} scene(s) failed.`,
          },
        });
        throw new ProviderError({
          provider: this.video.name,
          message: `${failed} of ${video.scenes.length} scenes failed to generate.`,
          retryable: true,
        });
      }

      await this.prisma.generationJob.update({
        where: { id: generationJob.id },
        data: {
          status: 'SUCCEEDED',
          scenesCompleted: completed,
          scenesFailed: 0,
          finishedAt: new Date(),
        },
      });

      return { next: VideoStatus.GENERATED, note: `${completed} scenes and voiceover generated.` };
    } catch (error) {
      await this.prisma.generationJob.updateMany({
        where: { id: generationJob.id, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          scenesCompleted: completed,
          scenesFailed: failed,
          finishedAt: new Date(),
          errorMessage: describeError(error).slice(0, 1000),
        },
      });
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Generates, polls and stores one scene.
   *
   * The provider job id is written to the database *before* the poll loop, which
   * is what makes a crash mid-generation recoverable rather than a repeat charge.
   */
  private async generateScene(
    videoId: string,
    scene: {
      id: string;
      index: number;
      prompt: string;
      negativePrompt: string | null;
      seed: number | null;
      durationSeconds: number;
      providerJobId: string | null;
    },
    jobId: string | null,
  ): Promise<void> {
    const format = this.config.media.format;
    // What the model will actually be asked for, and therefore what it bills. Whole
    // seconds, rounded up: video models take integer lengths, and a clip shorter
    // than its scene would end on a frozen frame. The epsilon keeps 4.00 at 4.
    const clipSeconds = clampClipSeconds(
      Math.ceil(scene.durationSeconds - 1e-6),
      this.config.video.clipMinSeconds,
      this.config.video.clipMaxSeconds,
    );

    let providerJobId = scene.providerJobId;

    if (!providerJobId) {
      await this.prisma.videoScene.update({
        where: { id: scene.id },
        data: { status: 'GENERATING', attempts: { increment: 1 } },
      });

      const handle = await this.metered.runRaw(
        {
          category: 'VIDEO',
          provider: this.video.name,
          model: this.config.video.model || null,
          operation: 'generateVideo',
          estimatedMicros: usdToMicros(clipSeconds * this.config.video.costPerSecond),
          fallbackUnits: clipSeconds,
          fallbackUnitLabel: 'seconds',
          videoId,
          jobId,
        },
        () =>
          this.video.generateVideo({
            prompt: scene.prompt,
            negativePrompt: scene.negativePrompt,
            durationSeconds: clipSeconds,
            width: format.width,
            height: format.height,
            fps: format.fps,
            seed: scene.seed,
            reference: `${videoId}:${scene.index}`,
          }),
      );

      providerJobId = handle.providerJobId;
      await this.prisma.videoScene.update({
        where: { id: scene.id },
        data: { providerJobId, providerName: handle.provider },
      });
    }

    const status = await pollUntil(
      async () => {
        const current = await this.video.getGenerationStatus(providerJobId as string);
        if (current.state === 'succeeded') return { done: true, value: current };
        if (current.state === 'failed') {
          throw new ProviderError({
            provider: this.video.name,
            message: current.error ?? 'Scene generation failed.',
            retryable: true,
          });
        }
        return { done: false };
      },
      {
        intervalMs: this.config.video.pollIntervalMs,
        timeoutMs: this.config.video.timeoutMs,
        label: `scene-${scene.index}`,
      },
    );

    if (!status.outputUrl) {
      throw new ProviderError({
        provider: this.video.name,
        message: 'Generation succeeded but no output URL was returned.',
        retryable: true,
      });
    }

    const download = await this.video.downloadVideo(status.outputUrl);
    const asset = await this.assets.storeStream(
      {
        videoId,
        kind: 'SCENE_VIDEO',
        contentType: download.contentType,
        sourceProvider: this.video.name,
        sourceModel: this.config.video.model || null,
        sourceReference: providerJobId,
        // Produced entirely by our own pipeline from our own prompt.
        licenseStatus: 'AI_GENERATED',
        durationSeconds: scene.durationSeconds,
      },
      download.stream,
      `scene-${String(scene.index).padStart(3, '0')}.mp4`,
    );

    await this.prisma.videoScene.update({
      where: { id: scene.id },
      data: { status: 'DOWNLOADED', assetId: asset.id, errorMessage: null },
    });
  }

  /**
   * Generates the narration track from the concatenated scene voiceovers and
   * returns its measured length in seconds, or `null` when there is nothing to say.
   *
   * The length is measured with ffprobe rather than taken from the provider:
   * ElevenLabs does not report one, and scene timing depends on it being right.
   */
  private async generateVoiceover(
    videoId: string,
    jobId: string | null,
    workDir: string,
  ): Promise<number | null> {
    const existing = await this.assets.findLatestForVideo(videoId, 'VOICEOVER');
    if (existing) {
      if (existing.durationSeconds) return existing.durationSeconds;
      // Recorded before durations were measured: measure it now.
      const path = await this.assets.downloadKeyToFile(
        existing.storageKey,
        join(workDir, `existing-voiceover${extensionFor(existing.contentType)}`),
      );
      return (await this.ffmpeg.probe(path)).durationSeconds;
    }

    const scenes = await this.prisma.videoScene.findMany({
      where: { videoId },
      orderBy: { index: 'asc' },
      select: { voiceover: true },
    });

    const narration = scenes
      .map((scene) => scene.voiceover.trim())
      .filter(Boolean)
      .join(' ');

    if (narration.length === 0) {
      this.logger.warn(`Video ${videoId} has no narration; skipping voice generation.`);
      return null;
    }

    // Resolve the voice from the video's lead character, falling back to config.
    const leadCharacter = await this.prisma.sceneCharacter.findFirst({
      where: { scene: { videoId } },
      include: { character: { select: { voiceId: true } } },
      orderBy: { scene: { index: 'asc' } },
    });

    const result = await this.metered.run(
      {
        category: 'VOICE',
        provider: this.voice.name,
        model: this.config.voice.model || null,
        operation: 'generateSpeech',
        estimatedMicros: usdToMicros((narration.length / 1000) * this.config.voice.costPer1kChars),
        fallbackUnits: narration.length,
        fallbackUnitLabel: 'characters',
        videoId,
        jobId,
      },
      () =>
        this.voice.generateSpeech({
          text: narration,
          voiceId: leadCharacter?.character.voiceId ?? (this.config.voice.defaultVoiceId || null),
          speed: 1,
          language: this.config.content.language,
          reference: videoId,
        }),
    );

    const filename = `voiceover${extensionFor(result.data.contentType)}`;
    const localPath = join(workDir, filename);
    await writeFile(localPath, result.data.audio);
    const measuredSeconds = (await this.ffmpeg.probe(localPath)).durationSeconds;

    await this.assets.storeBuffer(
      {
        videoId,
        kind: 'VOICEOVER',
        contentType: result.data.contentType,
        sourceProvider: this.voice.name,
        sourceModel: result.model,
        sourceReference: videoId,
        licenseStatus: 'AI_GENERATED',
        durationSeconds: measuredSeconds,
      },
      result.data.audio,
      filename,
    );
    return measuredSeconds;
  }

  /**
   * Re-times the scenes so each is on screen while its own text is spoken.
   *
   * The scene plan is the model's guess; the recording is the fact. The first real
   * video planned 38 s for 23 s of speech: the render stops with the voice, so the
   * last scenes were never shown, their clips were paid for anyway, and captions
   * timed from the plan lagged behind the voice.
   *
   * Only re-times before any clip has been ordered. Once one exists, its length is
   * committed and the stored plan must stay as it is.
   */
  private async alignScenesToNarration<
    T extends { id: string; voiceover: string; durationSeconds: number },
  >(
    scenes: Array<T & { assetId: string | null; providerJobId: string | null }>,
    narrationSeconds: number | null,
  ): Promise<Array<T & { assetId: string | null; providerJobId: string | null }>> {
    if (!narrationSeconds || narrationSeconds <= 0) return scenes;
    if (scenes.some((scene) => scene.assetId !== null || scene.providerJobId !== null)) {
      return scenes;
    }

    const durations = alignSceneDurations(
      scenes.map((scene) => scene.voiceover),
      narrationSeconds,
    );
    await this.prisma.$transaction(
      scenes.map((scene, index) =>
        this.prisma.videoScene.update({
          where: { id: scene.id },
          data: { durationSeconds: durations[index] },
        }),
      ),
    );

    const planned = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
    this.logger.log(
      `Re-timed ${scenes.length} scenes to the ${narrationSeconds.toFixed(1)}s narration ` +
        `(planned ${planned.toFixed(1)}s).`,
    );
    return scenes.map((scene, index) => ({ ...scene, durationSeconds: durations[index]! }));
  }
}

function extensionFor(contentType: string): string {
  if (contentType.includes('wav')) return '.wav';
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return '.mp3';
  if (contentType.includes('aac') || contentType.includes('mp4')) return '.m4a';
  return '.audio';
}
