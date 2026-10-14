import { type Env } from './env.schema';
import { type VideoFormatSpec } from '@shorts/contracts';

/**
 * Typed, grouped view over the validated environment.
 *
 * Services depend on a narrow slice of this (e.g. `config.media`) rather than on
 * `process.env`, which keeps them trivially testable — a test just hands over a
 * literal object.
 */
export class AppConfig {
  constructor(private readonly env: Env) {}

  get raw(): Env {
    return this.env;
  }

  get app() {
    return {
      env: this.env.NODE_ENV,
      role: this.env.APP_ROLE,
      port: this.env.PORT,
      logLevel: this.env.LOG_LEVEL,
      apiBaseUrl: this.env.API_BASE_URL.replace(/\/+$/, ''),
      webBaseUrl: this.env.WEB_BASE_URL.replace(/\/+$/, ''),
      timezone: this.env.TIMEZONE,
      version: this.env.APP_VERSION,
      isProduction: this.env.NODE_ENV === 'production',
      isTest: this.env.NODE_ENV === 'test',
    } as const;
  }

  /** Boot-time defaults for the operational switches. The database may override. */
  get safety() {
    return {
      dryRun: this.env.DRY_RUN,
      requireApproval: this.env.REQUIRE_APPROVAL,
      autoPublish: this.env.AUTO_PUBLISH,
      emergencyStop: this.env.EMERGENCY_STOP,
      defaultPrivacyStatus: this.env.DEFAULT_PRIVACY_STATUS,
      uncertainAction: this.env.SAFETY_UNCERTAIN_ACTION,
      llmReviewEnabled: this.env.SAFETY_LLM_REVIEW_ENABLED,
    } as const;
  }

  get quotas() {
    return {
      maxDailyUploads: this.env.MAX_DAILY_UPLOADS,
      maxMonthlyUploads: this.env.MAX_MONTHLY_UPLOADS,
      maxConcurrentGenerations: this.env.MAX_CONCURRENT_GENERATIONS,
      maxJobAttempts: this.env.MAX_JOB_ATTEMPTS,
    } as const;
  }

  get cost() {
    return {
      maxDailyUsd: this.env.MAX_DAILY_COST,
      maxMonthlyUsd: this.env.MAX_MONTHLY_COST,
      warnThreshold: this.env.COST_WARN_THRESHOLD,
    } as const;
  }

  get security() {
    return {
      sessionSecret: Buffer.from(this.env.SESSION_SECRET, 'base64'),
      encryptionKey: Buffer.from(this.env.ENCRYPTION_KEY, 'base64'),
      internalApiKey: this.env.INTERNAL_API_KEY,
      sessionTtlMs: this.env.SESSION_TTL_HOURS * 60 * 60 * 1000,
      sessionIdleTimeoutMs: this.env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000,
      corsOrigins:
        this.env.CORS_ALLOWED_ORIGINS.length > 0
          ? this.env.CORS_ALLOWED_ORIGINS
          : [this.env.WEB_BASE_URL],
      rateLimit: {
        windowSeconds: this.env.RATE_LIMIT_WINDOW_SECONDS,
        maxRequests: this.env.RATE_LIMIT_MAX_REQUESTS,
        authMaxRequests: this.env.RATE_LIMIT_AUTH_MAX_REQUESTS,
      },
      bootstrapAdmin: {
        email: this.env.BOOTSTRAP_ADMIN_EMAIL,
        password: this.env.BOOTSTRAP_ADMIN_PASSWORD,
      },
    } as const;
  }

  /**
   * Which adapter to wire for each port. DRY_RUN forces mocks for everything
   * that would otherwise cost money or publish something.
   */
  get providers() {
    const dryRun = this.env.DRY_RUN;
    return {
      llm: dryRun ? 'mock' : this.env.LLM_PROVIDER,
      video: dryRun ? 'mock' : this.env.VIDEO_PROVIDER,
      voice: dryRun ? 'mock' : this.env.VOICE_PROVIDER,
      youtube: dryRun ? 'mock' : this.env.YOUTUBE_PROVIDER,
      // Storage and queue are not billed per call and are safe to keep real,
      // so a dry run still exercises the true code path.
      storage: this.env.STORAGE_PROVIDER,
      queue: this.env.QUEUE_PROVIDER,
      /** What the operator asked for, before the dry-run override. */
      configured: {
        llm: this.env.LLM_PROVIDER,
        video: this.env.VIDEO_PROVIDER,
        voice: this.env.VOICE_PROVIDER,
        youtube: this.env.YOUTUBE_PROVIDER,
        storage: this.env.STORAGE_PROVIDER,
        queue: this.env.QUEUE_PROVIDER,
      },
    } as const;
  }

  get llm() {
    return {
      apiKey: this.env.LLM_API_KEY,
      model: this.env.LLM_MODEL,
      maxOutputTokens: this.env.LLM_MAX_OUTPUT_TOKENS,
      timeoutMs: this.env.LLM_TIMEOUT_MS,
      inputCostPerMTok: this.env.LLM_INPUT_COST_PER_MTOK,
      outputCostPerMTok: this.env.LLM_OUTPUT_COST_PER_MTOK,
    } as const;
  }

  get video() {
    return {
      apiKey: this.env.VIDEO_PROVIDER_API_KEY,
      baseUrl: this.env.VIDEO_PROVIDER_BASE_URL,
      model: this.env.VIDEO_MODEL,
      timeoutMs: this.env.VIDEO_TIMEOUT_MS,
      pollIntervalMs: this.env.VIDEO_POLL_INTERVAL_MS,
      costPerSecond: this.env.VIDEO_COST_PER_SECOND,
      inputOverrides: this.env.VIDEO_INPUT_OVERRIDES,
      clipMinSeconds: this.env.VIDEO_CLIP_MIN_SECONDS,
      clipMaxSeconds: this.env.VIDEO_CLIP_MAX_SECONDS,
    } as const;
  }

  get voice() {
    return {
      apiKey: this.env.VOICE_PROVIDER_API_KEY,
      baseUrl: this.env.VOICE_PROVIDER_BASE_URL,
      model: this.env.VOICE_MODEL,
      defaultVoiceId: this.env.VOICE_DEFAULT_VOICE_ID,
      timeoutMs: this.env.VOICE_TIMEOUT_MS,
      costPer1kChars: this.env.VOICE_COST_PER_1K_CHARS,
    } as const;
  }

  get storage() {
    return {
      localRoot: this.env.LOCAL_STORAGE_ROOT,
      gcsBucket: this.env.GCS_BUCKET,
      gcsProjectId: this.env.GCS_PROJECT_ID || this.env.GCP_PROJECT_ID,
      credentialsPath: this.env.GOOGLE_APPLICATION_CREDENTIALS,
    } as const;
  }

  get youtube() {
    return {
      clientId: this.env.YOUTUBE_CLIENT_ID,
      clientSecret: this.env.YOUTUBE_CLIENT_SECRET,
      redirectUri: this.env.YOUTUBE_REDIRECT_URI,
      defaultCategoryId: this.env.YOUTUBE_DEFAULT_CATEGORY_ID,
      madeForKids: this.env.YOUTUBE_MADE_FOR_KIDS,
      uploadTimeoutMs: this.env.YOUTUBE_UPLOAD_TIMEOUT_MS,
    } as const;
  }

  get gcp() {
    return {
      projectId: this.env.GCP_PROJECT_ID,
      region: this.env.GCP_REGION,
      tasksQueue: this.env.CLOUD_TASKS_QUEUE,
      tasksLocation: this.env.CLOUD_TASKS_LOCATION,
      tasksInvokerServiceAccount: this.env.CLOUD_TASKS_INVOKER_SA,
      tasksOidcAudience: this.env.CLOUD_TASKS_OIDC_AUDIENCE || this.env.API_BASE_URL,
    } as const;
  }

  get media() {
    return {
      ffmpegPath: this.env.FFMPEG_PATH,
      ffprobePath: this.env.FFPROBE_PATH,
      timeoutMs: this.env.FFMPEG_TIMEOUT_MS,
      subtitlesEnabled: this.env.SUBTITLES_ENABLED,
      subtitleStyle: this.env.SUBTITLE_STYLE,
      subtitleBottomMarginPercent: this.env.SUBTITLE_BOTTOM_MARGIN_PERCENT,
      format: {
        width: this.env.VIDEO_WIDTH,
        height: this.env.VIDEO_HEIGHT,
        fps: this.env.VIDEO_FPS,
        videoCodec: 'h264',
        audioCodec: 'aac',
        container: 'mp4',
        minDurationSeconds: this.env.VIDEO_MIN_DURATION_SECONDS,
        maxDurationSeconds: this.env.VIDEO_MAX_DURATION_SECONDS,
        loudnessTargetLufs: this.env.AUDIO_LOUDNESS_TARGET_LUFS,
      } satisfies VideoFormatSpec,
    } as const;
  }

  get content() {
    return {
      niche: this.env.CONTENT_NICHE,
      language: this.env.CONTENT_LANGUAGE,
      candidatesPerRequest: this.env.IDEA_CANDIDATES_PER_REQUEST,
      maxAttempts: this.env.IDEA_MAX_ATTEMPTS,
      similarity: {
        title: this.env.SIMILARITY_TITLE_THRESHOLD,
        script: this.env.SIMILARITY_SCRIPT_THRESHOLD,
        prompt: this.env.SIMILARITY_PROMPT_THRESHOLD,
        lookback: this.env.SIMILARITY_LOOKBACK,
      },
    } as const;
  }

  get analytics() {
    return {
      syncEnabled: this.env.ANALYTICS_SYNC_ENABLED,
      syncIntervalMinutes: this.env.ANALYTICS_SYNC_INTERVAL_MINUTES,
      retentionDays: this.env.ANALYTICS_RETENTION_DAYS,
    } as const;
  }
}
