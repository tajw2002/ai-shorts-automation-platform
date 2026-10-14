import { Injectable, Logger } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalMode, VideoStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { FfmpegRunner } from '@/infrastructure/ffmpeg/ffmpeg.runner';
import { AssetsService } from '@/modules/assets/assets.service';
import { QualityControlService } from '@/modules/media/quality-control.service';
import { SubtitleService } from '@/modules/media/subtitle.service';
import { SimilarityService } from '@/modules/similarity/similarity.service';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { parseLoudnormJson } from '@/modules/media/assembly.service';
import { QualityCheckFailedError } from '@/common/errors';
import {
  type PipelineContext,
  type PipelineStep,
  type PipelineStepResult,
} from '../pipeline.types';

/**
 * QUALITY_CHECK → READY_FOR_REVIEW | APPROVED | FAILED.
 *
 * The last gate before a video can reach YouTube. A failure here is terminal for
 * the run: the report is persisted so an operator can see exactly which rule
 * failed and decide whether to regenerate.
 *
 * Where it goes on success depends on the approval mode:
 *   MANUAL / SEMI_AUTO → READY_FOR_REVIEW (a human decides)
 *   AUTO               → APPROVED, but only when the report is completely clean
 */
@Injectable()
export class QualityControlStep implements PipelineStep {
  readonly from = VideoStatus.QUALITY_CHECK;
  readonly name = 'quality-control';

  private readonly logger = new Logger(QualityControlStep.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly ffmpeg: FfmpegRunner,
    private readonly assets: AssetsService,
    private readonly qc: QualityControlService,
    private readonly subtitles: SubtitleService,
    private readonly similarity: SimilarityService,
    private readonly settings: SystemSettingsService,
    private readonly systemLog: SystemLogService,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: context.videoId },
      include: { scenes: { orderBy: { index: 'asc' } } },
    });

    const finalAsset = await this.assets.findLatestForVideo(video.id, 'FINAL_VIDEO');
    const allAssets = await this.assets.findForVideo(video.id);

    const workDir = await mkdtemp(join(tmpdir(), 'shorts-qc-'));
    try {
      let probe = null;
      let integratedLufs: number | null = null;
      let fileExists = false;

      if (finalAsset) {
        const localPath = join(workDir, 'final.mp4');
        try {
          await this.assets.downloadKeyToFile(finalAsset.storageKey, localPath);
          probe = await this.ffmpeg.probe(localPath);
          fileExists = true;
          integratedLufs = await this.measureLoudness(localPath);
        } catch (error) {
          // A file that cannot be read is exactly what QC exists to catch, so this
          // becomes a failed check rather than a thrown error.
          this.logger.warn(`QC could not read the render for ${video.id}: ${String(error)}`);
        }
      }

      const cueCount = video.subtitlesEnabled
        ? this.subtitles.buildCues(
            video.scenes.map((scene) => ({
              voiceover: scene.voiceover,
              durationSeconds: scene.durationSeconds,
            })),
          ).length
        : 0;

      // Exclude this video's whole lineage. The assembly step fingerprinted the
      // title, and the title itself came from the idea — so without the idea and
      // script ids too, the check matches the content that produced it.
      const duplicate = video.title
        ? !(
            await this.similarity.check({
              title: video.title,
              exclude: {
                videoId: video.id,
                ideaId: video.ideaId,
                scriptId: video.scriptId,
              },
            })
          ).passed
        : false;

      const report = this.qc.evaluate({
        probe,
        fileExists,
        format: this.config.media.format,
        scenes: video.scenes.map((scene) => ({
          index: scene.index,
          durationSeconds: scene.durationSeconds,
          hasAsset: scene.assetId !== null,
        })),
        integratedLufs,
        subtitlesEnabled: video.subtitlesEnabled,
        subtitleCueCount: cueCount,
        title: video.title,
        description: video.description,
        safetyVerdict: video.safetyVerdict,
        duplicateDetected: duplicate,
        assetLicenses: allAssets.map((asset) => asset.licenseStatus),
      });

      await this.prisma.qualityReport.create({
        data: {
          videoId: video.id,
          passed: report.passed,
          failureCount: report.failureCount,
          warningCount: report.warningCount,
          checks: report.checks as never,
        },
      });

      if (!report.passed) {
        const failures = report.checks
          .filter((check) => check.status === 'FAIL')
          .map((check) => `${check.label}: ${check.message}`);

        await this.systemLog.error(
          'QualityControlStep',
          `Quality control failed for video ${video.id}.`,
          undefined,
          { videoId: video.id, jobId: context.jobId, failures },
        );

        throw new QualityCheckFailedError(`Quality control failed: ${failures.join(' | ')}`, {
          failures,
        });
      }

      // AUTO mode still requires a spotless report — a warning is precisely the
      // situation where a human should look before it becomes public.
      const approvalMode = await this.settings.getApprovalMode();
      const operational = await this.settings.getOperationalState();
      const canAutoApprove =
        approvalMode === ApprovalMode.AUTO &&
        !operational.requireApproval &&
        report.warningCount === 0;

      if (canAutoApprove) {
        return {
          next: VideoStatus.APPROVED,
          note: 'Quality control passed cleanly; auto-approved.',
        };
      }

      return {
        next: VideoStatus.READY_FOR_REVIEW,
        note:
          report.warningCount > 0
            ? `Quality control passed with ${report.warningCount} warning(s); awaiting review.`
            : 'Quality control passed; awaiting review.',
        // A human gate: the orchestrator must not advance past this on its own.
        halt: true,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Measures integrated loudness without producing output. */
  private async measureLoudness(path: string): Promise<number | null> {
    try {
      const { stderr } = await this.ffmpeg.runFfmpeg(
        ['-i', path, '-af', 'loudnorm=print_format=json', '-f', 'null', '-'],
        { label: 'qc-loudness', timeoutMs: 120_000 },
      );
      const measurement = parseLoudnormJson(stderr);
      if (!measurement) return null;
      const value = Number(measurement.input_i);
      return Number.isFinite(value) ? value : null;
    } catch {
      // Not being able to measure is a WARN in the report, not a hard failure.
      return null;
    }
  }
}
