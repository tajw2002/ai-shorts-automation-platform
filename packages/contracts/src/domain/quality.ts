import { type QualityCheckStatus } from '../enums';

/** One rule evaluated by quality control. */
export interface QualityCheck {
  /** Stable machine id, e.g. `resolution`, `audio_present`. */
  id: string;
  label: string;
  status: QualityCheckStatus;
  /** Human-readable explanation. Always populated for WARN/FAIL. */
  message: string;
  expected?: string;
  actual?: string;
}

export interface QualityReport {
  passed: boolean;
  checks: QualityCheck[];
  failureCount: number;
  warningCount: number;
  evaluatedAt: string;
}

/** Identifiers of the mandatory checks, so tests and UI can reference them safely. */
export const QualityCheckId = Object.freeze({
  FILE_PRESENT: 'file_present',
  FILE_SIZE: 'file_size',
  RESOLUTION: 'resolution',
  ASPECT_RATIO: 'aspect_ratio',
  DURATION: 'duration',
  VIDEO_CODEC: 'video_codec',
  AUDIO_CODEC: 'audio_codec',
  AUDIO_PRESENT: 'audio_present',
  AUDIO_LOUDNESS: 'audio_loudness',
  VIDEO_READABLE: 'video_readable',
  SCENES_PRESENT: 'scenes_present',
  SCENE_MIN_DURATION: 'scene_min_duration',
  SUBTITLES_PRESENT: 'subtitles_present',
  TITLE_PRESENT: 'title_present',
  DESCRIPTION_PRESENT: 'description_present',
  SAFETY_VERDICT: 'safety_verdict',
  DUPLICATE_CHECK: 'duplicate_check',
  ASSET_LICENSING: 'asset_licensing',
});
export type QualityCheckId = (typeof QualityCheckId)[keyof typeof QualityCheckId];
