import { z } from 'zod';
import { ApprovalMode, IdeaStatus, JobStatus, JobType, PrivacyStatus, VideoStatus } from '../enums';
import { contentIdeaDraftSchema, scriptDraftSchema } from '../domain/content';

/** Reusable primitives. */
export const idSchema = z.string().min(1).max(64);
export const isoDateSchema = z.string().datetime({ offset: true });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;

/**
 * Hands a const enum object to `z.enum` while preserving its literal types.
 *
 * Without the `T[keyof T]` cast the tuple degrades to `string[]`, and every
 * `z.infer` downstream becomes `string` — which then fails to assign to the
 * corresponding Prisma enum column.
 */
const enumValues = <T extends Record<string, string>>(e: T) =>
  Object.values(e) as [T[keyof T], ...T[keyof T][]];

/* -------------------------------------------------------------------------- */
/* Auth                                                                       */
/* -------------------------------------------------------------------------- */

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(200),
});
export type LoginDto = z.infer<typeof loginSchema>;

/* -------------------------------------------------------------------------- */
/* Characters                                                                 */
/* -------------------------------------------------------------------------- */

export const createCharacterSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  ageDescriptor: z.string().max(80).nullish(),
  species: z.string().max(80).default('human'),
  appearance: z.string().min(1).max(1200),
  outfit: z.string().max(600).nullish(),
  personality: z.string().max(600).default(''),
  voiceDescription: z.string().max(400).nullish(),
  voiceId: z.string().max(120).nullish(),
  visualStyle: z.string().max(600).default(''),
  promptDescription: z.string().min(1).max(2000),
  negativePrompt: z.string().max(1000).nullish(),
  visualSeed: z.number().int().nonnegative().nullish(),
  isActive: z.boolean().default(true),
});
export type CreateCharacterDto = z.infer<typeof createCharacterSchema>;
export const updateCharacterSchema = createCharacterSchema.partial();
export type UpdateCharacterDto = z.infer<typeof updateCharacterSchema>;

/* -------------------------------------------------------------------------- */
/* Ideas                                                                      */
/* -------------------------------------------------------------------------- */

export const generateIdeasSchema = z.object({
  count: z.number().int().min(1).max(10).default(1),
  niche: z.string().max(120).optional(),
  /** Steer generation, e.g. "focus on bedtime stories". */
  guidance: z.string().max(1000).optional(),
  characterIds: z.array(idSchema).max(6).optional(),
  /** Feed recent performance insights into the prompt. */
  usePerformanceInsights: z.boolean().default(true),
});
export type GenerateIdeasDto = z.infer<typeof generateIdeasSchema>;

export const createIdeaSchema = contentIdeaDraftSchema.extend({
  characterIds: z.array(idSchema).max(6).default([]),
});
export type CreateIdeaDto = z.infer<typeof createIdeaSchema>;
export const updateIdeaSchema = createIdeaSchema.partial().extend({
  status: z.enum(enumValues(IdeaStatus)).optional(),
});
export type UpdateIdeaDto = z.infer<typeof updateIdeaSchema>;

export const listIdeasSchema = paginationSchema.extend({
  status: z.enum(enumValues(IdeaStatus)).optional(),
  search: z.string().max(200).optional(),
});
export type ListIdeasDto = z.infer<typeof listIdeasSchema>;

/* -------------------------------------------------------------------------- */
/* Scripts & videos                                                           */
/* -------------------------------------------------------------------------- */

export const updateScriptSchema = scriptDraftSchema.partial();
export type UpdateScriptDto = z.infer<typeof updateScriptSchema>;

export const createVideoSchema = z.object({
  ideaId: idSchema,
  channelId: idSchema.optional(),
  /** Overrides the configured default when present. */
  targetDurationSeconds: z.number().int().min(5).max(180).optional(),
  subtitlesEnabled: z.boolean().optional(),
});
export type CreateVideoDto = z.infer<typeof createVideoSchema>;

export const listVideosSchema = paginationSchema.extend({
  status: z.enum(enumValues(VideoStatus)).optional(),
  channelId: idSchema.optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['createdAt', 'publishedAt', 'views', 'performanceScore']).default('createdAt'),
  direction: z.enum(['asc', 'desc']).default('desc'),
});
export type ListVideosDto = z.infer<typeof listVideosSchema>;

export const reviewVideoSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(1000).optional(),
});
export type ReviewVideoDto = z.infer<typeof reviewVideoSchema>;

export const regenerateVideoSchema = z.object({
  /** Which stage to rewind to. */
  from: z.enum(['script', 'scenes', 'video', 'voice', 'assembly', 'metadata']),
  reason: z.string().max(500).optional(),
});
export type RegenerateVideoDto = z.infer<typeof regenerateVideoSchema>;

export const updateVideoMetadataSchema = z.object({
  title: z.string().min(3).max(100).optional(),
  description: z.string().min(10).max(5000).optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  hashtags: z.array(z.string().min(1).max(40)).max(15).optional(),
  categoryId: z.string().max(10).optional(),
});
export type UpdateVideoMetadataDto = z.infer<typeof updateVideoMetadataSchema>;

/* -------------------------------------------------------------------------- */
/* Publishing                                                                 */
/* -------------------------------------------------------------------------- */

export const schedulePublishSchema = z.object({
  /**
   * Optional: the video's own channel, else the default channel, is used. The
   * dashboard's "Publish now" sends no channel, and requiring one made that
   * button fail validation every time.
   */
  channelId: idSchema.optional(),
  /** ISO 8601 with offset. Must be in the future. */
  publishAt: isoDateSchema.nullable().default(null),
  privacyStatus: z.enum(enumValues(PrivacyStatus)).optional(),
});
export type SchedulePublishDto = z.infer<typeof schedulePublishSchema>;

export const scheduleSlotSchema = z.object({
  /** 0 = Sunday … 6 = Saturday. `null` means every day. */
  dayOfWeek: z.number().int().min(0).max(6).nullable().default(null),
  /** 24h local time in the schedule's timezone. */
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59).default(0),
});

export const createScheduleSchema = z.object({
  name: z.string().min(1).max(120),
  channelId: idSchema,
  timezone: z.string().min(1).max(64).default('Europe/Berlin'),
  videosPerDay: z.number().int().min(0).max(10).default(1),
  slots: z.array(scheduleSlotSchema).min(1).max(24),
  approvalMode: z.enum(enumValues(ApprovalMode)).default(ApprovalMode.MANUAL),
  isActive: z.boolean().default(false),
});
export type CreateScheduleDto = z.infer<typeof createScheduleSchema>;
export const updateScheduleSchema = createScheduleSchema.partial();
export type UpdateScheduleDto = z.infer<typeof updateScheduleSchema>;

/* -------------------------------------------------------------------------- */
/* Jobs & system                                                              */
/* -------------------------------------------------------------------------- */

export const listJobsSchema = paginationSchema.extend({
  status: z.enum(enumValues(JobStatus)).optional(),
  type: z.enum(enumValues(JobType)).optional(),
  videoId: idSchema.optional(),
});
export type ListJobsDto = z.infer<typeof listJobsSchema>;

export const listLogsSchema = paginationSchema.extend({
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']).optional(),
  service: z.string().max(80).optional(),
  videoId: idSchema.optional(),
  jobId: idSchema.optional(),
  since: isoDateSchema.optional(),
});
export type ListLogsDto = z.infer<typeof listLogsSchema>;

export const updateSettingsSchema = z.object({
  emergencyStop: z.boolean().optional(),
  generationPaused: z.boolean().optional(),
  uploadsPaused: z.boolean().optional(),
  autoPublish: z.boolean().optional(),
  requireApproval: z.boolean().optional(),
  approvalMode: z.enum(enumValues(ApprovalMode)).optional(),
  maxDailyUploads: z.number().int().min(0).max(50).optional(),
  maxMonthlyUploads: z.number().int().min(0).max(1000).optional(),
  maxDailyCostUsd: z.number().min(0).max(10000).optional(),
  maxMonthlyCostUsd: z.number().min(0).max(100000).optional(),
  defaultPrivacyStatus: z.enum(enumValues(PrivacyStatus)).optional(),
  subtitlesEnabled: z.boolean().optional(),
});
export type UpdateSettingsDto = z.infer<typeof updateSettingsSchema>;

export const emergencyStopSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type EmergencyStopDto = z.infer<typeof emergencyStopSchema>;

/* -------------------------------------------------------------------------- */
/* Internal task payloads (Cloud Tasks → /internal/tasks)                     */
/* -------------------------------------------------------------------------- */

export const taskEnvelopeSchema = z.object({
  jobId: idSchema,
  type: z.enum(enumValues(JobType)),
  /** Guards against duplicate delivery; the worker claims by this key. */
  idempotencyKey: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type TaskEnvelope = z.infer<typeof taskEnvelopeSchema>;
