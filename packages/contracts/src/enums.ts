/**
 * Canonical enumerations for the platform.
 *
 * These are the single source of truth. `prisma/schema.prisma` mirrors them and
 * `test/unit/enum-parity.spec.ts` fails the build if the two drift apart.
 *
 * They are expressed as frozen const objects (rather than TypeScript `enum`s) so
 * the values are plain strings at runtime, serialise cleanly over HTTP and can be
 * compared against Prisma's generated string unions without casting.
 */

/**
 * `const T` is essential: without it TypeScript widens each property to `string`,
 * so `VideoStatus` would be `string` rather than a union of its literals — and
 * every assignment to a Prisma enum column would need a cast.
 */
function asEnum<const T extends Record<string, string>>(values: T): Readonly<T> {
  return Object.freeze(values);
}

/** Where a video currently sits in the production pipeline. */
export const VideoStatus = asEnum({
  CREATED: 'CREATED',
  SCRIPT_GENERATED: 'SCRIPT_GENERATED',
  SCENES_PLANNED: 'SCENES_PLANNED',
  GENERATING: 'GENERATING',
  GENERATED: 'GENERATED',
  ASSEMBLING: 'ASSEMBLING',
  QUALITY_CHECK: 'QUALITY_CHECK',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  QUEUED: 'QUEUED',
  UPLOADING: 'UPLOADING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});
export type VideoStatus = (typeof VideoStatus)[keyof typeof VideoStatus];

/**
 * Statuses from which the orchestrator will not advance on its own.
 * REJECTED/FAILED/CANCELLED need an operator; READY_FOR_REVIEW needs approval;
 * PUBLISHED is done.
 */
export const TERMINAL_VIDEO_STATUSES: readonly VideoStatus[] = Object.freeze([
  VideoStatus.PUBLISHED,
  VideoStatus.FAILED,
  VideoStatus.REJECTED,
  VideoStatus.CANCELLED,
]);

export const HUMAN_GATE_VIDEO_STATUSES: readonly VideoStatus[] = Object.freeze([
  VideoStatus.READY_FOR_REVIEW,
]);

export const SceneStatus = asEnum({
  PENDING: 'PENDING',
  GENERATING: 'GENERATING',
  GENERATED: 'GENERATED',
  DOWNLOADED: 'DOWNLOADED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});
export type SceneStatus = (typeof SceneStatus)[keyof typeof SceneStatus];

export const IdeaStatus = asEnum({
  DRAFT: 'DRAFT',
  READY: 'READY',
  IN_PRODUCTION: 'IN_PRODUCTION',
  USED: 'USED',
  ARCHIVED: 'ARCHIVED',
  BLOCKED: 'BLOCKED',
});
export type IdeaStatus = (typeof IdeaStatus)[keyof typeof IdeaStatus];

/** Queue/worker mechanics. */
export const JobStatus = asEnum({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  DEAD_LETTER: 'DEAD_LETTER',
});
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const JobType = asEnum({
  IDEA_GENERATION: 'IDEA_GENERATION',
  SCRIPT_GENERATION: 'SCRIPT_GENERATION',
  SCENE_PLANNING: 'SCENE_PLANNING',
  VIDEO_GENERATION: 'VIDEO_GENERATION',
  VOICE_GENERATION: 'VOICE_GENERATION',
  ASSEMBLY: 'ASSEMBLY',
  QUALITY_CONTROL: 'QUALITY_CONTROL',
  METADATA_GENERATION: 'METADATA_GENERATION',
  UPLOAD: 'UPLOAD',
  ANALYTICS_SYNC: 'ANALYTICS_SYNC',
  PERFORMANCE_ANALYSIS: 'PERFORMANCE_ANALYSIS',
  PIPELINE_ADVANCE: 'PIPELINE_ADVANCE',
});
export type JobType = (typeof JobType)[keyof typeof JobType];

export const GenerationJobStatus = asEnum({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});
export type GenerationJobStatus = (typeof GenerationJobStatus)[keyof typeof GenerationJobStatus];

export const UploadJobStatus = asEnum({
  PENDING: 'PENDING',
  UPLOADING: 'UPLOADING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});
export type UploadJobStatus = (typeof UploadJobStatus)[keyof typeof UploadJobStatus];

/** How much human involvement the operator wants. */
export const ApprovalMode = asEnum({
  MANUAL: 'MANUAL',
  SEMI_AUTO: 'SEMI_AUTO',
  AUTO: 'AUTO',
});
export type ApprovalMode = (typeof ApprovalMode)[keyof typeof ApprovalMode];

export const PrivacyStatus = asEnum({
  private: 'private',
  unlisted: 'unlisted',
  public: 'public',
});
export type PrivacyStatus = (typeof PrivacyStatus)[keyof typeof PrivacyStatus];

export const AssetKind = asEnum({
  SCENE_VIDEO: 'SCENE_VIDEO',
  SCENE_IMAGE: 'SCENE_IMAGE',
  VOICEOVER: 'VOICEOVER',
  MUSIC: 'MUSIC',
  SOUND_EFFECT: 'SOUND_EFFECT',
  SUBTITLES: 'SUBTITLES',
  FINAL_VIDEO: 'FINAL_VIDEO',
  THUMBNAIL: 'THUMBNAIL',
});
export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

/**
 * Provenance of every stored asset. We refuse to publish anything whose
 * licence cannot be accounted for.
 */
export const LicenseStatus = asEnum({
  /** Produced by our own AI pipeline. */
  AI_GENERATED: 'AI_GENERATED',
  /** Derived by us from our own generated material (renders, mixes, subtitles). */
  DERIVED_OWN: 'DERIVED_OWN',
  /** Third-party asset we hold an explicit licence for. */
  LICENSED: 'LICENSED',
  /** Public domain / CC0. */
  PUBLIC_DOMAIN: 'PUBLIC_DOMAIN',
  /** Provenance not established — blocks publishing. */
  UNKNOWN: 'UNKNOWN',
});
export type LicenseStatus = (typeof LicenseStatus)[keyof typeof LicenseStatus];

export const PUBLISHABLE_LICENSE_STATUSES: readonly LicenseStatus[] = Object.freeze([
  LicenseStatus.AI_GENERATED,
  LicenseStatus.DERIVED_OWN,
  LicenseStatus.LICENSED,
  LicenseStatus.PUBLIC_DOMAIN,
]);

export const SafetyVerdict = asEnum({
  ALLOW: 'ALLOW',
  REVIEW: 'REVIEW',
  BLOCK: 'BLOCK',
});
export type SafetyVerdict = (typeof SafetyVerdict)[keyof typeof SafetyVerdict];

export const SafetyCategory = asEnum({
  VIOLENCE: 'VIOLENCE',
  SEXUAL: 'SEXUAL',
  SELF_HARM: 'SELF_HARM',
  DANGEROUS_CHALLENGE: 'DANGEROUS_CHALLENGE',
  HATE: 'HATE',
  ILLEGAL_ACTIVITY: 'ILLEGAL_ACTIVITY',
  MEDICAL_ADVICE: 'MEDICAL_ADVICE',
  CHILD_SAFETY: 'CHILD_SAFETY',
  COPYRIGHT_RISK: 'COPYRIGHT_RISK',
  REAL_PERSON: 'REAL_PERSON',
  PROFANITY: 'PROFANITY',
});
export type SafetyCategory = (typeof SafetyCategory)[keyof typeof SafetyCategory];

export const QualityCheckStatus = asEnum({
  PASS: 'PASS',
  WARN: 'WARN',
  FAIL: 'FAIL',
});
export type QualityCheckStatus = (typeof QualityCheckStatus)[keyof typeof QualityCheckStatus];

export const ProviderKind = asEnum({
  LLM: 'LLM',
  VIDEO: 'VIDEO',
  VOICE: 'VOICE',
  STORAGE: 'STORAGE',
  YOUTUBE: 'YOUTUBE',
  QUEUE: 'QUEUE',
});
export type ProviderKind = (typeof ProviderKind)[keyof typeof ProviderKind];

export const HealthStatus = asEnum({
  OK: 'OK',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  DISABLED: 'DISABLED',
});
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

export const LogLevel = asEnum({
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  FATAL: 'FATAL',
});
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const UserRole = asEnum({
  ADMIN: 'ADMIN',
  EDITOR: 'EDITOR',
  VIEWER: 'VIEWER',
});
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const ScheduleStatus = asEnum({
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
});
export type ScheduleStatus = (typeof ScheduleStatus)[keyof typeof ScheduleStatus];

export const CostCategory = asEnum({
  LLM: 'LLM',
  VIDEO: 'VIDEO',
  VOICE: 'VOICE',
  STORAGE: 'STORAGE',
  OTHER: 'OTHER',
});
export type CostCategory = (typeof CostCategory)[keyof typeof CostCategory];
