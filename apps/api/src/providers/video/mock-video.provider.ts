import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FfmpegRunner } from '@/infrastructure/ffmpeg/ffmpeg.runner';
import { ProviderError } from '@/common/errors';
import { errorHealth, okHealth, type ProviderHealth } from '../provider.types';
import {
  type VideoDownload,
  type VideoGenerationHandle,
  type VideoGenerationRequest,
  type VideoGenerationStatus,
  type VideoProvider,
} from './video-provider.interface';

/**
 * Renders a real, playable placeholder clip instead of calling a paid model.
 *
 * Producing genuine H.264 rather than a stub file matters: it means the assembly,
 * subtitle, loudness and quality-control stages all execute their real code paths
 * during a dry run, so DRY_RUN exercises the pipeline rather than bypassing it.
 *
 * Each scene gets a deterministic colour derived from its prompt, so a generated
 * short is visually distinguishable scene by scene.
 */
@Injectable()
export class MockVideoProvider implements VideoProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockVideoProvider.name);
  private readonly jobs = new Map<string, MockJob>();

  constructor(private readonly ffmpeg: FfmpegRunner) {}

  isConfigured(): boolean {
    return true;
  }

  missingConfiguration(): string[] {
    return [];
  }

  async healthCheck(): Promise<ProviderHealth> {
    const availability = await this.ffmpeg.checkAvailability();
    if (!availability.available) {
      // Honest reporting: the mock cannot produce a valid clip without ffmpeg,
      // and a silent placeholder would fail quality control later anyway.
      return errorHealth(`Mock video provider needs ffmpeg. ${availability.message}`);
    }
    return okHealth('Mock video provider — renders local placeholder clips.', 0);
  }

  describe(): Record<string, string | number | boolean | null> {
    return { model: 'mock-video-v1', rendersRealMp4: true, cost: 0 };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationHandle> {
    const providerJobId = `mock-${createHash('sha256')
      .update(`${request.reference}|${request.prompt}|${request.seed ?? ''}`)
      .digest('hex')
      .slice(0, 16)}`;

    const outputPath = join(await this.workDir(), `${providerJobId}.mp4`);
    this.jobs.set(providerJobId, { state: 'running', outputPath, request });

    // Render eagerly but without blocking the caller, mirroring how a real
    // provider behaves: the handle comes back immediately, the work finishes later.
    void this.render(providerJobId, request, outputPath);

    return {
      providerJobId,
      provider: this.name,
      model: 'mock-video-v1',
      estimatedCostMicros: 0,
    };
  }

  async getGenerationStatus(providerJobId: string): Promise<VideoGenerationStatus> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      return {
        state: 'failed',
        progress: null,
        outputUrl: null,
        error: `Unknown mock job '${providerJobId}'. It may have been evicted by a restart.`,
        actualCostMicros: 0,
      };
    }
    return {
      state: job.state,
      progress: job.state === 'succeeded' ? 1 : 0.5,
      outputUrl: job.state === 'succeeded' ? `file://${job.outputPath}` : null,
      error: job.error ?? null,
      actualCostMicros: 0,
    };
  }

  async downloadVideo(outputUrl: string): Promise<VideoDownload> {
    const path = outputUrl.startsWith('file://') ? outputUrl.slice('file://'.length) : outputUrl;
    let sizeBytes: number | null = null;
    try {
      sizeBytes = (await stat(path)).size;
    } catch (error) {
      throw new ProviderError({
        provider: this.name,
        message: `Rendered clip is missing at ${path}.`,
        cause: error,
      });
    }
    return { stream: createReadStream(path), contentType: 'video/mp4', sizeBytes };
  }

  async cancelGeneration(providerJobId: string): Promise<void> {
    const job = this.jobs.get(providerJobId);
    if (!job) return;
    job.state = 'failed';
    job.error = 'Cancelled by operator.';
    await unlink(job.outputPath).catch(() => undefined);
  }

  // -- internals ------------------------------------------------------------

  private async render(
    providerJobId: string,
    request: VideoGenerationRequest,
    outputPath: string,
  ): Promise<void> {
    const job = this.jobs.get(providerJobId);
    if (!job) return;

    try {
      const colour = colourFromPrompt(request.prompt, request.seed);
      const duration = Math.max(0.5, request.durationSeconds).toFixed(2);

      // A solid colour with a slow-moving noise overlay: valid H.264, small,
      // deterministic, and visually distinct per scene without needing fonts
      // (drawtext is not compiled into every ffmpeg build).
      await this.ffmpeg.runFfmpeg(
        [
          '-f',
          'lavfi',
          '-i',
          `color=c=${colour}:s=${request.width}x${request.height}:r=${request.fps}:d=${duration}`,
          '-f',
          'lavfi',
          '-i',
          `nullsrc=s=${request.width}x${request.height}:r=${request.fps}:d=${duration}`,
          '-filter_complex',
          '[1:v]geq=random(1)*40:128:128,format=yuv420p[grain];' +
            '[0:v][grain]blend=all_mode=overlay:all_opacity=0.12,format=yuv420p[v]',
          '-map',
          '[v]',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-t',
          duration,
          outputPath,
        ],
        { label: `mock-render:${providerJobId}`, timeoutMs: 120_000 },
      );

      job.state = 'succeeded';
    } catch (error) {
      this.logger.warn(`Mock render failed for ${providerJobId}: ${String(error)}`);
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : 'Mock render failed.';
    }
  }

  private async workDir(): Promise<string> {
    const dir = join(tmpdir(), 'shorts-mock-video');
    await mkdir(dir, { recursive: true });
    return dir;
  }
}

interface MockJob {
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  outputPath: string;
  request: VideoGenerationRequest;
  error?: string;
}

/** Deterministic, reasonably pleasant colour derived from the scene prompt. */
export function colourFromPrompt(prompt: string, seed: number | null): string {
  const digest = createHash('sha256')
    .update(`${prompt}|${seed ?? ''}`)
    .digest();
  // Keep the channels in the mid range so the clip is never pure black or white,
  // which would make loudness/brightness style checks meaningless.
  const channel = (index: number) => 60 + ((digest[index] as number) % 140);
  return `0x${[channel(0), channel(1), channel(2)]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')}`;
}
