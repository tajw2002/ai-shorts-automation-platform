import { z } from 'zod';

/**
 * Environment contract.
 *
 * The application refuses to boot when this fails. That is deliberate: a missing
 * encryption key or a malformed budget is far cheaper to discover at startup than
 * three steps into a paid pipeline run.
 */

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeNumber = z.coerce.number().min(0);
const nonNegativeInt = z.coerce.number().int().min(0);

/**
 * A JSON object supplied as one env var. Empty means "none".
 *
 * Used for provider inputs that differ per model and so cannot be hard-coded in
 * an adapter, e.g. `{"fps":24,"resolution":"720p"}`.
 */
const jsonObject = z
  .string()
  .default('')
  .transform((raw, ctx): Record<string, unknown> => {
    if (raw.trim() === '') return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the issue below
    }
    ctx.addIssue({ code: 'custom', message: 'must be a JSON object, e.g. {"fps":24}' });
    return z.NEVER;
  });

/** A base64-encoded 32-byte key. Rejects anything shorter — no weak keys. */
const base64Key32 = z
  .string()
  .min(1)
  .refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'must be exactly 32 bytes encoded as base64 (generate: openssl rand -base64 32)' },
  );

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/** Validates an IANA timezone using the platform's own tz database. */
const timezone = z
  .string()
  .default('Europe/Berlin')
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid IANA timezone, e.g. Europe/Berlin' },
  );

export const envSchema = z
  .object({
    // Runtime -----------------------------------------------------------------
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
    PORT: port.default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_BASE_URL: z.string().url().default('http://localhost:3001'),
    WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
    TIMEZONE: timezone,
    APP_VERSION: z.string().default('0.1.0'),

    // Safety switches ---------------------------------------------------------
    DRY_RUN: booleanish.default(true),
    REQUIRE_APPROVAL: booleanish.default(true),
    AUTO_PUBLISH: booleanish.default(false),
    EMERGENCY_STOP: booleanish.default(false),
    DEFAULT_PRIVACY_STATUS: z.enum(['private', 'unlisted', 'public']).default('private'),

    // Quotas ------------------------------------------------------------------
    MAX_DAILY_UPLOADS: z.coerce.number().int().min(0).default(3),
    MAX_MONTHLY_UPLOADS: z.coerce.number().int().min(0).default(60),
    MAX_CONCURRENT_GENERATIONS: positiveInt.default(2),
    MAX_JOB_ATTEMPTS: positiveInt.default(3),

    // Cost --------------------------------------------------------------------
    MAX_DAILY_COST: nonNegativeNumber.default(10),
    MAX_MONTHLY_COST: nonNegativeNumber.default(200),
    COST_WARN_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),

    // Database ----------------------------------------------------------------
    DATABASE_URL: z.string().min(1),

    // Security ----------------------------------------------------------------
    SESSION_SECRET: base64Key32,
    ENCRYPTION_KEY: base64Key32,
    INTERNAL_API_KEY: z.string().min(16),
    SESSION_TTL_HOURS: positiveInt.default(12),
    SESSION_IDLE_TIMEOUT_MINUTES: positiveInt.default(60),
    CORS_ALLOWED_ORIGINS: csv,
    RATE_LIMIT_WINDOW_SECONDS: positiveInt.default(60),
    RATE_LIMIT_MAX_REQUESTS: positiveInt.default(120),
    RATE_LIMIT_AUTH_MAX_REQUESTS: positiveInt.default(10),
    BOOTSTRAP_ADMIN_EMAIL: z.string().email().default('admin@example.com'),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().default(''),

    // Provider selection ------------------------------------------------------
    LLM_PROVIDER: z.enum(['mock', 'anthropic', 'openai']).default('mock'),
    VIDEO_PROVIDER: z.enum(['mock', 'replicate', 'fal']).default('mock'),
    VOICE_PROVIDER: z.enum(['mock', 'elevenlabs', 'openai']).default('mock'),
    STORAGE_PROVIDER: z.enum(['local', 'gcs']).default('local'),
    YOUTUBE_PROVIDER: z.enum(['mock', 'google']).default('mock'),
    QUEUE_PROVIDER: z.enum(['inmemory', 'cloudtasks']).default('inmemory'),

    // LLM ---------------------------------------------------------------------
    LLM_API_KEY: z.string().default(''),
    LLM_MODEL: z.string().default('claude-sonnet-5'),
    LLM_MAX_OUTPUT_TOKENS: positiveInt.default(4096),
    LLM_TIMEOUT_MS: positiveInt.default(120_000),
    LLM_INPUT_COST_PER_MTOK: nonNegativeNumber.default(3),
    LLM_OUTPUT_COST_PER_MTOK: nonNegativeNumber.default(15),

    // Video -------------------------------------------------------------------
    VIDEO_PROVIDER_API_KEY: z.string().default(''),
    VIDEO_PROVIDER_BASE_URL: z.string().default(''),
    VIDEO_MODEL: z.string().default(''),
    VIDEO_TIMEOUT_MS: positiveInt.default(600_000),
    VIDEO_POLL_INTERVAL_MS: positiveInt.default(5_000),
    VIDEO_COST_PER_SECOND: nonNegativeNumber.default(0.05),
    // Per-model provider inputs merged over the common ones. A `null` value
    // removes a key. Look at the model's input schema before setting these.
    VIDEO_INPUT_OVERRIDES: jsonObject,
    // Clip length the selected model accepts, in seconds. 0 = unbounded.
    VIDEO_CLIP_MIN_SECONDS: nonNegativeInt.default(0),
    VIDEO_CLIP_MAX_SECONDS: nonNegativeInt.default(0),

    // Voice -------------------------------------------------------------------
    VOICE_PROVIDER_API_KEY: z.string().default(''),
    VOICE_PROVIDER_BASE_URL: z.string().default(''),
    VOICE_MODEL: z.string().default(''),
    VOICE_DEFAULT_VOICE_ID: z.string().default(''),
    VOICE_TIMEOUT_MS: positiveInt.default(120_000),
    VOICE_COST_PER_1K_CHARS: nonNegativeNumber.default(0.3),

    // Storage -----------------------------------------------------------------
    LOCAL_STORAGE_ROOT: z.string().default('./storage'),
    GCS_BUCKET: z.string().default(''),
    GCS_PROJECT_ID: z.string().default(''),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().default(''),

    // YouTube -----------------------------------------------------------------
    YOUTUBE_CLIENT_ID: z.string().default(''),
    YOUTUBE_CLIENT_SECRET: z.string().default(''),
    YOUTUBE_REDIRECT_URI: z.string().default('http://localhost:3001/api/v1/youtube/oauth/callback'),
    YOUTUBE_DEFAULT_CATEGORY_ID: z.string().regex(/^\d+$/).default('24'),
    YOUTUBE_MADE_FOR_KIDS: booleanish.default(false),
    YOUTUBE_UPLOAD_TIMEOUT_MS: positiveInt.default(900_000),

    // Google Cloud ------------------------------------------------------------
    GCP_PROJECT_ID: z.string().default(''),
    GCP_REGION: z.string().default('europe-west1'),
    CLOUD_TASKS_QUEUE: z.string().default('shorts-jobs'),
    CLOUD_TASKS_LOCATION: z.string().default('europe-west1'),
    CLOUD_TASKS_INVOKER_SA: z.string().default(''),
    CLOUD_TASKS_OIDC_AUDIENCE: z.string().default(''),

    // Media -------------------------------------------------------------------
    FFMPEG_PATH: z.string().default('ffmpeg'),
    FFPROBE_PATH: z.string().default('ffprobe'),
    FFMPEG_TIMEOUT_MS: positiveInt.default(900_000),
    VIDEO_WIDTH: positiveInt.default(1080),
    VIDEO_HEIGHT: positiveInt.default(1920),
    VIDEO_FPS: positiveInt.default(30),
    VIDEO_MIN_DURATION_SECONDS: positiveInt.default(15),
    VIDEO_MAX_DURATION_SECONDS: positiveInt.default(60),
    AUDIO_LOUDNESS_TARGET_LUFS: z.coerce.number().default(-14),
    SUBTITLES_ENABLED: booleanish.default(true),
    SUBTITLE_STYLE: z.string().default('default'),
    SUBTITLE_BOTTOM_MARGIN_PERCENT: z.coerce.number().min(0).max(60).default(22),

    // Content engine ----------------------------------------------------------
    CONTENT_NICHE: z.string().default('cute-ai-baby-and-animal-stories'),
    CONTENT_LANGUAGE: z.string().default('en'),
    IDEA_CANDIDATES_PER_REQUEST: positiveInt.default(5),
    IDEA_MAX_ATTEMPTS: positiveInt.default(3),
    SIMILARITY_TITLE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
    SIMILARITY_SCRIPT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
    SIMILARITY_PROMPT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
    SIMILARITY_LOOKBACK: positiveInt.default(300),

    // Safety ------------------------------------------------------------------
    SAFETY_UNCERTAIN_ACTION: z.enum(['block', 'review']).default('review'),
    SAFETY_LLM_REVIEW_ENABLED: booleanish.default(false),

    // Analytics ---------------------------------------------------------------
    ANALYTICS_SYNC_ENABLED: booleanish.default(true),
    ANALYTICS_SYNC_INTERVAL_MINUTES: positiveInt.default(180),
    ANALYTICS_RETENTION_DAYS: positiveInt.default(400),
  })
  .superRefine((env, ctx) => {
    const addIssue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.VIDEO_CLIP_MAX_SECONDS > 0 && env.VIDEO_CLIP_MIN_SECONDS > env.VIDEO_CLIP_MAX_SECONDS) {
      addIssue('VIDEO_CLIP_MIN_SECONDS', 'must not exceed VIDEO_CLIP_MAX_SECONDS');
    }

    // A production deployment must not silently run on mocks or with the
    // defaults that only make sense on a laptop.
    if (env.NODE_ENV === 'production') {
      if (env.STORAGE_PROVIDER === 'local') {
        addIssue('STORAGE_PROVIDER', 'local storage is not durable on Cloud Run; use gcs');
      }
      if (env.API_BASE_URL.startsWith('http://')) {
        addIssue('API_BASE_URL', 'must be https in production');
      }
      if (env.CORS_ALLOWED_ORIGINS.length === 0) {
        addIssue('CORS_ALLOWED_ORIGINS', 'must list the dashboard origin explicitly');
      }
    }

    // Selecting a real provider without a key is a configuration error we can
    // catch now rather than at the first paid call.
    const requireKey = (selected: boolean, key: string, varName: string, providerVar: string) => {
      if (selected && !key) {
        addIssue(varName, `${providerVar} requires ${varName} to be set`);
      }
    };
    requireKey(env.LLM_PROVIDER !== 'mock', env.LLM_API_KEY, 'LLM_API_KEY', 'LLM_PROVIDER');
    requireKey(
      env.VIDEO_PROVIDER !== 'mock',
      env.VIDEO_PROVIDER_API_KEY,
      'VIDEO_PROVIDER_API_KEY',
      'VIDEO_PROVIDER',
    );
    requireKey(
      env.VOICE_PROVIDER !== 'mock',
      env.VOICE_PROVIDER_API_KEY,
      'VOICE_PROVIDER_API_KEY',
      'VOICE_PROVIDER',
    );
    if (env.STORAGE_PROVIDER === 'gcs' && !env.GCS_BUCKET) {
      addIssue('GCS_BUCKET', 'STORAGE_PROVIDER=gcs requires GCS_BUCKET');
    }
    if (env.YOUTUBE_PROVIDER === 'google') {
      if (!env.YOUTUBE_CLIENT_ID)
        addIssue('YOUTUBE_CLIENT_ID', 'required for YOUTUBE_PROVIDER=google');
      if (!env.YOUTUBE_CLIENT_SECRET)
        addIssue('YOUTUBE_CLIENT_SECRET', 'required for YOUTUBE_PROVIDER=google');
    }
    if (env.QUEUE_PROVIDER === 'cloudtasks') {
      if (!env.GCP_PROJECT_ID) addIssue('GCP_PROJECT_ID', 'required for QUEUE_PROVIDER=cloudtasks');
      if (!env.CLOUD_TASKS_INVOKER_SA)
        addIssue('CLOUD_TASKS_INVOKER_SA', 'required so /internal endpoints can verify OIDC');
    }

    if (env.VIDEO_MIN_DURATION_SECONDS >= env.VIDEO_MAX_DURATION_SECONDS) {
      addIssue('VIDEO_MIN_DURATION_SECONDS', 'must be less than VIDEO_MAX_DURATION_SECONDS');
    }
    if (env.MAX_DAILY_COST > env.MAX_MONTHLY_COST) {
      addIssue('MAX_DAILY_COST', 'must not exceed MAX_MONTHLY_COST');
    }
  });

export type Env = z.infer<typeof envSchema>;
