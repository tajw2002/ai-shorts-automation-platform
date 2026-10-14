import { Injectable, Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MediaProbeResult, type VideoFormatSpec } from '@shorts/contracts';
import { FfmpegRunner } from '@/infrastructure/ffmpeg/ffmpeg.runner';
import { MediaProcessingError } from '@/common/errors';

/**
 * Final render.
 *
 * Everything ffmpeg-shaped lives here so command construction is reviewable in
 * one file rather than scattered across the pipeline. Two deliberate choices:
 *
 *  - **Re-encode rather than stream-copy when concatenating.** Scene clips come
 *    from a generator and are not guaranteed to share timebase, SAR or GOP
 *    structure; `-c copy` produces files that play locally and then stutter or
 *    desync after YouTube re-encodes them. Correctness wins over a few seconds.
 *  - **Two-pass loudness.** `loudnorm` in single-pass mode approximates; measuring
 *    first and then applying the measured values hits the EBU R128 target
 *    properly, which is what keeps a channel's volume consistent video to video.
 */

export interface SceneInput {
  /** Local path to the scene clip. */
  path: string;
  durationSeconds: number;
}

export interface AssemblyRequest {
  scenes: SceneInput[];
  /** Local path to the voiceover track, when one exists. */
  voiceoverPath: string | null;
  /** Optional background music, mixed well below the voice. */
  musicPath: string | null;
  /** Local path to an ASS subtitle file, when subtitles are enabled. */
  subtitlePath: string | null;
  outputPath: string;
  format: VideoFormatSpec;
}

export interface AssemblyResult {
  outputPath: string;
  probe: MediaProbeResult;
}

/** Music sits far enough under the narration to stay intelligible on a phone. */
const MUSIC_GAIN_DB = -18;

@Injectable()
export class AssemblyService {
  private readonly logger = new Logger(AssemblyService.name);

  constructor(private readonly ffmpeg: FfmpegRunner) {}

  async assemble(request: AssemblyRequest): Promise<AssemblyResult> {
    if (request.scenes.length === 0) {
      throw new MediaProcessingError('Cannot assemble a video with no scenes.');
    }

    const workDir = await mkdtemp(join(tmpdir(), 'shorts-assembly-'));
    try {
      const normalizedPath = join(workDir, 'video.mp4');
      await this.concatScenes(request.scenes, normalizedPath, request.format);

      const audioPath = await this.buildAudioTrack(request, workDir);

      await this.mux({
        videoPath: normalizedPath,
        audioPath,
        subtitlePath: request.subtitlePath,
        outputPath: request.outputPath,
        format: request.format,
      });

      const probe = await this.ffmpeg.probe(request.outputPath);
      return { outputPath: request.outputPath, probe };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Concatenates scenes, normalising each to the target geometry first.
   *
   * `scale` + `pad` rather than a bare `scale`: a generator that returns a
   * slightly different aspect ratio should be letterboxed, not stretched, which
   * would visibly distort a character's face.
   */
  private async concatScenes(
    scenes: SceneInput[],
    outputPath: string,
    format: VideoFormatSpec,
  ): Promise<void> {
    const { width, height, fps } = format;

    const inputs = scenes.flatMap((scene) => ['-i', scene.path]);
    const filters = scenes
      .map(
        (scene, index) =>
          `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
          `setsar=1,fps=${fps},format=yuv420p,${fitToDuration(scene.durationSeconds)}[v${index}]`,
      )
      .join(';');

    const concatInputs = scenes.map((_, index) => `[v${index}]`).join('');
    const filterComplex = `${filters};${concatInputs}concat=n=${scenes.length}:v=1:a=0[outv]`;

    await this.ffmpeg.runFfmpeg(
      [
        ...inputs,
        '-filter_complex',
        filterComplex,
        '-map',
        '[outv]',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(fps),
        outputPath,
      ],
      { label: 'concat-scenes' },
    );
  }

  /**
   * Builds the final audio track: voice, optional music, loudness-normalised.
   * Returns null when there is nothing to mix — a silent short is still valid.
   */
  private async buildAudioTrack(request: AssemblyRequest, workDir: string): Promise<string | null> {
    if (!request.voiceoverPath && !request.musicPath) return null;

    const mixedPath = join(workDir, 'audio-mixed.wav');

    if (request.voiceoverPath && request.musicPath) {
      // `duration=first` keeps the mix as long as the narration; music that runs
      // past the end would be cut mid-note by the muxing step anyway.
      await this.ffmpeg.runFfmpeg(
        [
          '-i',
          request.voiceoverPath,
          '-i',
          request.musicPath,
          '-filter_complex',
          `[1:a]volume=${MUSIC_GAIN_DB}dB[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[out]`,
          '-map',
          '[out]',
          '-c:a',
          'pcm_s16le',
          '-ar',
          '48000',
          mixedPath,
        ],
        { label: 'mix-audio' },
      );
    } else {
      const source = (request.voiceoverPath ?? request.musicPath) as string;
      await this.ffmpeg.runFfmpeg(
        ['-i', source, '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', mixedPath],
        { label: 'prepare-audio' },
      );
    }

    return this.normalizeLoudness(mixedPath, join(workDir, 'audio-final.wav'), request.format);
  }

  /**
   * Two-pass EBU R128 normalisation.
   *
   * Pass one measures; pass two applies the measurements. If the measurement pass
   * cannot be parsed we fall back to single-pass rather than failing the render —
   * slightly-off loudness is a much smaller problem than a lost video.
   */
  private async normalizeLoudness(
    inputPath: string,
    outputPath: string,
    format: VideoFormatSpec,
  ): Promise<string> {
    const target = format.loudnessTargetLufs;
    const measurement = await this.measureLoudness(inputPath, target);

    const loudnormFilter = measurement
      ? `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${measurement.input_i}:` +
        `measured_TP=${measurement.input_tp}:measured_LRA=${measurement.input_lra}:` +
        `measured_thresh=${measurement.input_thresh}:offset=${measurement.target_offset}:linear=true`
      : `loudnorm=I=${target}:TP=-1.5:LRA=11`;

    await this.ffmpeg.runFfmpeg(
      ['-i', inputPath, '-af', loudnormFilter, '-c:a', 'pcm_s16le', '-ar', '48000', outputPath],
      { label: 'loudness-normalise' },
    );

    return outputPath;
  }

  private async measureLoudness(
    inputPath: string,
    target: number,
  ): Promise<LoudnormMeasurement | null> {
    try {
      const { stderr } = await this.ffmpeg.runFfmpeg(
        [
          '-i',
          inputPath,
          '-af',
          `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`,
          '-f',
          'null',
          '-',
        ],
        { label: 'loudness-measure' },
      );
      return parseLoudnormJson(stderr);
    } catch (error) {
      this.logger.warn(
        `Loudness measurement failed; falling back to single pass. ${String(error)}`,
      );
      return null;
    }
  }

  /** Final mux: video + audio + burned-in subtitles → H.264/AAC MP4. */
  private async mux(input: {
    videoPath: string;
    audioPath: string | null;
    subtitlePath: string | null;
    outputPath: string;
    format: VideoFormatSpec;
  }): Promise<void> {
    const args: string[] = ['-i', input.videoPath];
    if (input.audioPath) args.push('-i', input.audioPath);

    if (input.subtitlePath) {
      // The path is escaped for the filter-graph mini-language, where ':' and
      // '\' are separators. A temp path is machine-generated, but escaping keeps
      // this correct if that ever changes.
      args.push('-vf', `subtitles=${escapeFilterPath(input.subtitlePath)}`);
      args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p');
    } else {
      // Nothing touches the pixels, so the concat output can be copied through.
      args.push('-c:v', 'copy');
    }

    if (input.audioPath) {
      args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
      // Stop at whichever stream ends first so a longer music bed cannot extend
      // the video past its visual content.
      args.push('-shortest');
    } else {
      args.push('-an');
    }

    args.push(
      '-map',
      '0:v:0',
      ...(input.audioPath ? ['-map', '1:a:0'] : []),
      // Puts the MP4 index at the front so playback can start before the whole
      // file is downloaded — expected for anything served over the web.
      '-movflags',
      '+faststart',
      input.outputPath,
    );

    await this.ffmpeg.runFfmpeg(args, { label: 'mux-final' });

    const stats = await stat(input.outputPath).catch(() => null);
    if (!stats || stats.size === 0) {
      throw new MediaProcessingError('The final render produced an empty file.');
    }
  }

  /** Writes a subtitle file to disk for the burn-in step. */
  async writeSubtitleFile(content: string, workDir: string): Promise<string> {
    const path = join(workDir, 'captions.ass');
    await writeFile(path, content, 'utf8');
    return path;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

export interface LoudnormMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/**
 * Makes a clip last exactly `seconds`: longer clips are cut, shorter ones hold
 * their last frame.
 *
 * Scene durations follow the narration, and video models only produce whole
 * seconds within a fixed range, so a clip rarely matches its scene exactly.
 * Without this, every mismatch would shift all later scenes against the captions
 * and the voice. A non-positive duration leaves the clip untouched.
 */
export function fitToDuration(seconds: number): string {
  if (!(seconds > 0)) return 'null';
  const value = seconds.toFixed(3);
  return `tpad=stop_mode=clone:stop_duration=${value},trim=duration=${value},setpts=PTS-STARTPTS`;
}

/**
 * Extracts loudnorm's JSON block from ffmpeg's stderr.
 *
 * ffmpeg prints it among ordinary log output, so the last balanced `{...}` block
 * is taken rather than assuming a fixed position.
 */
export function parseLoudnormJson(stderr: string): LoudnormMeasurement | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    const parsed = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnormMeasurement>;
    if (
      parsed.input_i === undefined ||
      parsed.input_tp === undefined ||
      parsed.input_lra === undefined ||
      parsed.input_thresh === undefined ||
      parsed.target_offset === undefined
    ) {
      return null;
    }
    return parsed as LoudnormMeasurement;
  } catch {
    return null;
  }
}

/** Escapes a filesystem path for use inside an ffmpeg filter graph. */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}
