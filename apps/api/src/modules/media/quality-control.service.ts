import { Injectable } from '@nestjs/common';
import {
  type MediaProbeResult,
  type QualityCheck,
  QualityCheckId,
  type QualityReport,
  PUBLISHABLE_LICENSE_STATUSES,
  type LicenseStatus,
  type SafetyVerdict,
  type VideoFormatSpec,
} from '@shorts/contracts';

/**
 * Quality control.
 *
 * The gate every video passes before it can be published. It is implemented as a
 * pure function over an already-gathered set of facts rather than as something
 * that reaches out to probe files itself — which means the whole rule set can be
 * unit tested exhaustively, and the pipeline decides once where the facts come from.
 *
 * A check is FAIL when it makes the video unpublishable, WARN when a human should
 * look but publishing is still defensible.
 */

export interface QualityControlInput {
  probe: MediaProbeResult | null;
  fileExists: boolean;
  format: VideoFormatSpec;
  scenes: Array<{ index: number; durationSeconds: number; hasAsset: boolean }>;
  /** Measured integrated loudness, when it could be determined. */
  integratedLufs: number | null;
  subtitlesEnabled: boolean;
  subtitleCueCount: number;
  title: string | null;
  description: string | null;
  safetyVerdict: SafetyVerdict;
  /** True when the similarity layer found a near-duplicate of this video. */
  duplicateDetected: boolean;
  assetLicenses: LicenseStatus[];
}

/** Tolerances that reflect real encoder behaviour rather than exact equality. */
const FPS_TOLERANCE = 1;
const DURATION_TOLERANCE_SECONDS = 1.5;
const ASPECT_TOLERANCE = 0.02;
const MIN_SCENE_SECONDS = 0.5;
const MIN_FILE_BYTES = 10 * 1024;
/** How far from the loudness target is acceptable before flagging it. */
const LOUDNESS_TOLERANCE_LU = 3;

@Injectable()
export class QualityControlService {
  evaluate(input: QualityControlInput): QualityReport {
    return evaluateQuality(input);
  }
}

export function evaluateQuality(input: QualityControlInput): QualityReport {
  const checks: QualityCheck[] = [];
  const add = (check: QualityCheck) => checks.push(check);

  /* -- File ---------------------------------------------------------------- */

  if (!input.fileExists || !input.probe) {
    add({
      id: QualityCheckId.FILE_PRESENT,
      label: 'Rendered file present',
      status: 'FAIL',
      message: 'The rendered video file is missing or could not be read.',
    });
    // Every remaining check depends on the probe, so stop here with a clear reason.
    return summarize(checks);
  }

  const probe = input.probe;
  add({
    id: QualityCheckId.FILE_PRESENT,
    label: 'Rendered file present',
    status: 'PASS',
    message: 'The rendered file exists and is readable.',
  });

  add({
    id: QualityCheckId.FILE_SIZE,
    label: 'File size',
    status: probe.sizeBytes >= MIN_FILE_BYTES ? 'PASS' : 'FAIL',
    message:
      probe.sizeBytes >= MIN_FILE_BYTES
        ? `${(probe.sizeBytes / 1_048_576).toFixed(1)} MB.`
        : 'The file is implausibly small and is almost certainly corrupt.',
    expected: `>= ${MIN_FILE_BYTES} bytes`,
    actual: `${probe.sizeBytes} bytes`,
  });

  /* -- Video stream -------------------------------------------------------- */

  if (!probe.video) {
    add({
      id: QualityCheckId.VIDEO_READABLE,
      label: 'Video stream',
      status: 'FAIL',
      message: 'The file contains no readable video stream.',
    });
  } else {
    add({
      id: QualityCheckId.VIDEO_READABLE,
      label: 'Video stream',
      status: 'PASS',
      message: `${probe.video.codec} ${probe.video.width}x${probe.video.height} @ ${probe.video.fps}fps.`,
    });

    const resolutionOk =
      probe.video.width === input.format.width && probe.video.height === input.format.height;
    add({
      id: QualityCheckId.RESOLUTION,
      label: 'Resolution',
      status: resolutionOk ? 'PASS' : 'FAIL',
      message: resolutionOk
        ? 'Matches the configured output resolution.'
        : 'The render does not match the configured output resolution.',
      expected: `${input.format.width}x${input.format.height}`,
      actual: `${probe.video.width}x${probe.video.height}`,
    });

    // 9:16 is what makes YouTube treat the upload as a Short at all.
    const expectedAspect = input.format.width / input.format.height;
    const actualAspect = probe.video.height > 0 ? probe.video.width / probe.video.height : 0;
    const aspectOk = Math.abs(actualAspect - expectedAspect) <= ASPECT_TOLERANCE;
    add({
      id: QualityCheckId.ASPECT_RATIO,
      label: 'Aspect ratio',
      status: aspectOk ? 'PASS' : 'FAIL',
      message: aspectOk
        ? 'Vertical 9:16, as Shorts requires.'
        : 'The aspect ratio is not vertical 9:16; YouTube may not treat this as a Short.',
      expected: expectedAspect.toFixed(3),
      actual: actualAspect.toFixed(3),
    });

    const codecOk = normalizeCodec(probe.video.codec) === 'h264';
    add({
      id: QualityCheckId.VIDEO_CODEC,
      label: 'Video codec',
      status: codecOk ? 'PASS' : 'FAIL',
      message: codecOk ? 'H.264 as configured.' : 'Unexpected video codec.',
      expected: 'h264',
      actual: probe.video.codec,
    });

    const fpsOk = Math.abs(probe.video.fps - input.format.fps) <= FPS_TOLERANCE;
    if (!fpsOk) {
      add({
        id: 'frame_rate',
        label: 'Frame rate',
        status: 'WARN',
        message: 'The frame rate differs from the configured target.',
        expected: `${input.format.fps}fps`,
        actual: `${probe.video.fps}fps`,
      });
    }
  }

  /* -- Duration ------------------------------------------------------------ */

  const duration = probe.durationSeconds;
  const withinRange =
    duration >= input.format.minDurationSeconds - DURATION_TOLERANCE_SECONDS &&
    duration <= input.format.maxDurationSeconds + DURATION_TOLERANCE_SECONDS;
  add({
    id: QualityCheckId.DURATION,
    label: 'Duration',
    status: withinRange ? 'PASS' : 'FAIL',
    message: withinRange
      ? `${duration.toFixed(1)}s, within the configured range.`
      : 'The duration is outside the configured range for a Short.',
    expected: `${input.format.minDurationSeconds}-${input.format.maxDurationSeconds}s`,
    actual: `${duration.toFixed(1)}s`,
  });

  /* -- Audio --------------------------------------------------------------- */

  if (!probe.audio) {
    add({
      id: QualityCheckId.AUDIO_PRESENT,
      label: 'Audio stream',
      status: 'FAIL',
      message: 'The render has no audio track.',
    });
  } else {
    add({
      id: QualityCheckId.AUDIO_PRESENT,
      label: 'Audio stream',
      status: 'PASS',
      message: `${probe.audio.codec}, ${probe.audio.channels}ch @ ${probe.audio.sampleRate}Hz.`,
    });

    const audioCodecOk = normalizeCodec(probe.audio.codec) === 'aac';
    add({
      id: QualityCheckId.AUDIO_CODEC,
      label: 'Audio codec',
      status: audioCodecOk ? 'PASS' : 'FAIL',
      message: audioCodecOk ? 'AAC as configured.' : 'Unexpected audio codec.',
      expected: 'aac',
      actual: probe.audio.codec,
    });

    if (probe.audio.channels === 0) {
      add({
        id: 'audio_channels',
        label: 'Audio channels',
        status: 'FAIL',
        message: 'The audio track reports zero channels and is corrupt.',
      });
    }
  }

  if (input.integratedLufs === null) {
    add({
      id: QualityCheckId.AUDIO_LOUDNESS,
      label: 'Loudness',
      status: probe.audio ? 'WARN' : 'FAIL',
      message: probe.audio
        ? 'Loudness could not be measured; publishing without a level check.'
        : 'No audio to measure.',
    });
  } else {
    // Digital silence measures around -70 LUFS; that means the mix failed.
    const silent = input.integratedLufs <= -50;
    const offTarget =
      Math.abs(input.integratedLufs - input.format.loudnessTargetLufs) > LOUDNESS_TOLERANCE_LU;

    add({
      id: QualityCheckId.AUDIO_LOUDNESS,
      label: 'Loudness',
      status: silent ? 'FAIL' : offTarget ? 'WARN' : 'PASS',
      message: silent
        ? 'The audio track is effectively silent.'
        : offTarget
          ? 'Loudness is further from the target than expected.'
          : 'Loudness is on target.',
      expected: `${input.format.loudnessTargetLufs} LUFS ±${LOUDNESS_TOLERANCE_LU}`,
      actual: `${input.integratedLufs.toFixed(1)} LUFS`,
    });
  }

  /* -- Scenes -------------------------------------------------------------- */

  const missingAssets = input.scenes.filter((scene) => !scene.hasAsset);
  add({
    id: QualityCheckId.SCENES_PRESENT,
    label: 'Scenes rendered',
    status: input.scenes.length === 0 ? 'FAIL' : missingAssets.length > 0 ? 'FAIL' : 'PASS',
    message:
      input.scenes.length === 0
        ? 'The video has no scenes.'
        : missingAssets.length > 0
          ? `${missingAssets.length} scene(s) have no rendered asset.`
          : `All ${input.scenes.length} scenes rendered.`,
  });

  const tooShort = input.scenes.filter((scene) => scene.durationSeconds < MIN_SCENE_SECONDS);
  add({
    id: QualityCheckId.SCENE_MIN_DURATION,
    label: 'Scene durations',
    status: tooShort.length > 0 ? 'FAIL' : 'PASS',
    message:
      tooShort.length > 0
        ? `Scene(s) ${tooShort.map((s) => s.index).join(', ')} are shorter than ${MIN_SCENE_SECONDS}s.`
        : 'No degenerate scenes.',
  });

  /* -- Subtitles ----------------------------------------------------------- */

  if (input.subtitlesEnabled) {
    add({
      id: QualityCheckId.SUBTITLES_PRESENT,
      label: 'Subtitles',
      status: input.subtitleCueCount > 0 ? 'PASS' : 'FAIL',
      message:
        input.subtitleCueCount > 0
          ? `${input.subtitleCueCount} caption cues.`
          : 'Subtitles are enabled but no cues were produced.',
    });
  }

  /* -- Metadata ------------------------------------------------------------ */

  const hasTitle = Boolean(input.title && input.title.trim().length >= 3);
  add({
    id: QualityCheckId.TITLE_PRESENT,
    label: 'Title',
    status: hasTitle ? 'PASS' : 'FAIL',
    message: hasTitle ? 'Present.' : 'The video has no usable title.',
  });

  const hasDescription = Boolean(input.description && input.description.trim().length >= 10);
  add({
    id: QualityCheckId.DESCRIPTION_PRESENT,
    label: 'Description',
    status: hasDescription ? 'PASS' : 'FAIL',
    message: hasDescription ? 'Present.' : 'The video has no usable description.',
  });

  /* -- Policy -------------------------------------------------------------- */

  add({
    id: QualityCheckId.SAFETY_VERDICT,
    label: 'Content safety',
    status:
      input.safetyVerdict === 'ALLOW' ? 'PASS' : input.safetyVerdict === 'REVIEW' ? 'WARN' : 'FAIL',
    message:
      input.safetyVerdict === 'ALLOW'
        ? 'Cleared by the safety layer.'
        : input.safetyVerdict === 'REVIEW'
          ? 'Flagged for human review by the safety layer.'
          : 'Blocked by the safety layer.',
  });

  add({
    id: QualityCheckId.DUPLICATE_CHECK,
    label: 'Originality',
    status: input.duplicateDetected ? 'FAIL' : 'PASS',
    message: input.duplicateDetected
      ? 'A near-duplicate of this content already exists.'
      : 'No near-duplicate found.',
  });

  // Nothing publishes unless every asset's provenance is accounted for.
  const unlicensed = input.assetLicenses.filter(
    (status) => !PUBLISHABLE_LICENSE_STATUSES.includes(status),
  );
  add({
    id: QualityCheckId.ASSET_LICENSING,
    label: 'Asset licensing',
    status: unlicensed.length > 0 ? 'FAIL' : 'PASS',
    message:
      unlicensed.length > 0
        ? `${unlicensed.length} asset(s) have unestablished provenance.`
        : 'Every asset has a known, publishable licence status.',
  });

  return summarize(checks);
}

function summarize(checks: QualityCheck[]): QualityReport {
  const failureCount = checks.filter((check) => check.status === 'FAIL').length;
  const warningCount = checks.filter((check) => check.status === 'WARN').length;
  return {
    passed: failureCount === 0,
    checks,
    failureCount,
    warningCount,
    evaluatedAt: new Date().toISOString(),
  };
}

/** ffprobe reports variants such as `h264` / `avc1` and `aac` / `aac_latm`. */
function normalizeCodec(codec: string): string {
  const lower = codec.toLowerCase();
  if (lower.includes('264') || lower.includes('avc')) return 'h264';
  if (lower.startsWith('aac')) return 'aac';
  return lower;
}
