import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { AppConfig } from '@/config/app-config';
import { MediaProcessingError } from '@/common/errors';
import { type MediaProbeResult } from '@shorts/contracts';

/**
 * The only place in the codebase that starts a process.
 *
 * Arguments are always passed as an array — never a shell string — so a prompt or
 * a title containing shell metacharacters cannot turn into command injection.
 * Every invocation has a hard timeout and a bounded stderr buffer.
 */

export interface FfmpegRunOptions {
  timeoutMs?: number;
  /** Label used in errors and logs, e.g. `concat-scenes`. */
  label: string;
  /** Called with each stderr chunk — ffmpeg reports progress there. */
  onStderr?: (chunk: string) => void;
}

export interface FfmpegRunResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** ffmpeg is chatty; keep only the tail, which is where the error lives. */
const MAX_CAPTURED_STDERR = 64 * 1024;

@Injectable()
export class FfmpegRunner {
  private readonly logger = new Logger(FfmpegRunner.name);

  constructor(private readonly config: AppConfig) {}

  get ffmpegPath(): string {
    return this.config.media.ffmpegPath;
  }

  get ffprobePath(): string {
    return this.config.media.ffprobePath;
  }

  async runFfmpeg(args: string[], options: FfmpegRunOptions): Promise<FfmpegRunResult> {
    return this.execute(this.ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], options);
  }

  async runFfprobe(args: string[], options: FfmpegRunOptions): Promise<FfmpegRunResult> {
    return this.execute(this.ffprobePath, ['-hide_banner', ...args], options);
  }

  /** Structured `ffprobe` output, normalised into the shape the platform uses. */
  async probe(filePath: string): Promise<MediaProbeResult> {
    const { stdout } = await this.runFfprobe(
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { label: 'probe', timeoutMs: 60_000 },
    );

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(stdout) as FfprobeOutput;
    } catch (error) {
      throw new MediaProcessingError(
        'ffprobe returned output that is not valid JSON.',
        {
          filePath,
        },
        error,
      );
    }

    const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
    const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

    return {
      durationSeconds: Number(parsed.format?.duration ?? 0),
      sizeBytes: Number(parsed.format?.size ?? 0),
      formatName: parsed.format?.format_name ?? 'unknown',
      video: videoStream
        ? {
            codec: videoStream.codec_name ?? 'unknown',
            width: Number(videoStream.width ?? 0),
            height: Number(videoStream.height ?? 0),
            fps: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
            bitRate: videoStream.bit_rate ? Number(videoStream.bit_rate) : null,
          }
        : null,
      audio: audioStream
        ? {
            codec: audioStream.codec_name ?? 'unknown',
            sampleRate: Number(audioStream.sample_rate ?? 0),
            channels: Number(audioStream.channels ?? 0),
            bitRate: audioStream.bit_rate ? Number(audioStream.bit_rate) : null,
          }
        : null,
    };
  }

  /** Reports whether the binaries are present, for the System Health page. */
  async checkAvailability(): Promise<{
    available: boolean;
    version: string | null;
    message: string;
  }> {
    try {
      const { stdout } = await this.execute(this.ffmpegPath, ['-version'], {
        label: 'version',
        timeoutMs: 10_000,
      });
      const version = stdout.split('\n')[0]?.trim() ?? null;
      await this.execute(this.ffprobePath, ['-version'], { label: 'version', timeoutMs: 10_000 });
      return { available: true, version, message: version ?? 'ffmpeg present' };
    } catch (error) {
      return {
        available: false,
        version: null,
        message:
          error instanceof Error
            ? `ffmpeg/ffprobe unavailable: ${error.message}`
            : 'ffmpeg/ffprobe unavailable',
      };
    }
  }

  private execute(
    command: string,
    args: string[],
    options: FfmpegRunOptions,
  ): Promise<FfmpegRunResult> {
    const timeoutMs = options.timeoutMs ?? this.config.media.timeoutMs;
    const startedAt = Date.now();

    return new Promise<FfmpegRunResult>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Explicitly no shell. This is what makes array arguments safe.
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(
          new MediaProcessingError(`${options.label}: ${command} timed out after ${timeoutMs}ms.`, {
            command,
            timeoutMs,
            stderr: tail(stderr),
          }),
        );
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        options.onStderr?.(text);
        stderr = tail(stderr + text);
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new MediaProcessingError(
            `${options.label}: failed to start ${command}. Is it installed and on PATH?`,
            { command },
            error,
          ),
        );
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const durationMs = Date.now() - startedAt;

        if (code === 0) {
          resolve({ stdout, stderr, durationMs });
          return;
        }
        this.logger.debug(`${options.label} failed: ${tail(stderr, 2000)}`);
        reject(
          new MediaProcessingError(
            `${options.label}: ${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
            { command, code, signal, stderr: tail(stderr, 4000) },
          ),
        );
      });
    });
  }
}

function tail(value: string, max = MAX_CAPTURED_STDERR): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

/** ffprobe reports frame rates as a rational string such as `30000/1001`. */
export function parseFrameRate(value: string | undefined): number {
  if (!value) return 0;
  const [numerator, denominator] = value.split('/');
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return Math.round((n / d) * 1000) / 1000;
}

interface FfprobeOutput {
  format?: { duration?: string; size?: string; format_name?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    bit_rate?: string;
    sample_rate?: string;
    channels?: number;
  }>;
}
