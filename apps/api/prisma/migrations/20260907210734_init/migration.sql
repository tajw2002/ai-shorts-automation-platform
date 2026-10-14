-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('CREATED', 'SCRIPT_GENERATED', 'SCENES_PLANNED', 'GENERATING', 'GENERATED', 'ASSEMBLING', 'QUALITY_CHECK', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'QUEUED', 'UPLOADING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SceneStatus" AS ENUM ('PENDING', 'GENERATING', 'GENERATED', 'DOWNLOADED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "IdeaStatus" AS ENUM ('DRAFT', 'READY', 'IN_PRODUCTION', 'USED', 'ARCHIVED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('IDEA_GENERATION', 'SCRIPT_GENERATION', 'SCENE_PLANNING', 'VIDEO_GENERATION', 'VOICE_GENERATION', 'ASSEMBLY', 'QUALITY_CONTROL', 'METADATA_GENERATION', 'UPLOAD', 'ANALYTICS_SYNC', 'PERFORMANCE_ANALYSIS', 'PIPELINE_ADVANCE');

-- CreateEnum
CREATE TYPE "GenerationJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UploadJobStatus" AS ENUM ('PENDING', 'UPLOADING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalMode" AS ENUM ('MANUAL', 'SEMI_AUTO', 'AUTO');

-- CreateEnum
CREATE TYPE "PrivacyStatus" AS ENUM ('private', 'unlisted', 'public');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('SCENE_VIDEO', 'SCENE_IMAGE', 'VOICEOVER', 'MUSIC', 'SOUND_EFFECT', 'SUBTITLES', 'FINAL_VIDEO', 'THUMBNAIL');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('AI_GENERATED', 'DERIVED_OWN', 'LICENSED', 'PUBLIC_DOMAIN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SafetyVerdict" AS ENUM ('ALLOW', 'REVIEW', 'BLOCK');

-- CreateEnum
CREATE TYPE "SafetyCategory" AS ENUM ('VIOLENCE', 'SEXUAL', 'SELF_HARM', 'DANGEROUS_CHALLENGE', 'HATE', 'ILLEGAL_ACTIVITY', 'MEDICAL_ADVICE', 'CHILD_SAFETY', 'COPYRIGHT_RISK', 'REAL_PERSON', 'PROFANITY');

-- CreateEnum
CREATE TYPE "QualityCheckStatus" AS ENUM ('PASS', 'WARN', 'FAIL');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('LLM', 'VIDEO', 'VOICE', 'STORAGE', 'YOUTUBE', 'QUEUE');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('OK', 'WARNING', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "CostCategory" AS ENUM ('LLM', 'VIDEO', 'VOICE', 'STORAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "FingerprintKind" AS ENUM ('IDEA_TITLE', 'IDEA_PREMISE', 'SCRIPT_NARRATION', 'SCENE_PROMPT', 'VIDEO_TITLE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "csrfSecret" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "youtubeChannelId" TEXT,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "thumbnailUrl" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "defaultCategoryId" TEXT NOT NULL DEFAULT '24',
    "defaultPrivacy" "PrivacyStatus" NOT NULL DEFAULT 'private',
    "madeForKids" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthCredential" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "refreshTokenEnc" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ageDescriptor" TEXT,
    "species" TEXT NOT NULL DEFAULT 'human',
    "appearance" TEXT NOT NULL,
    "outfit" TEXT,
    "personality" TEXT NOT NULL DEFAULT '',
    "voiceDescription" TEXT,
    "voiceId" TEXT,
    "visualStyle" TEXT NOT NULL DEFAULT '',
    "promptDescription" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "visualSeed" INTEGER,
    "promptRevision" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentIdea" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "premise" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "beats" TEXT[],
    "tone" TEXT NOT NULL DEFAULT 'wholesome',
    "targetDurationSeconds" INTEGER NOT NULL DEFAULT 30,
    "noveltyRationale" TEXT NOT NULL DEFAULT '',
    "niche" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "status" "IdeaStatus" NOT NULL DEFAULT 'DRAFT',
    "safetyVerdict" "SafetyVerdict" NOT NULL DEFAULT 'ALLOW',
    "safetyFindings" JSONB,
    "similarityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "generatedBy" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdeaCharacter" (
    "ideaId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "IdeaCharacter_pkey" PRIMARY KEY ("ideaId","characterId")
);

-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "callToAction" TEXT NOT NULL DEFAULT '',
    "estimatedDurationSeconds" DOUBLE PRECISION NOT NULL,
    "scenes" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "safetyVerdict" "SafetyVerdict" NOT NULL DEFAULT 'ALLOW',
    "safetyFindings" JSONB,
    "similarityScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "generatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentFingerprint" (
    "id" TEXT NOT NULL,
    "kind" "FingerprintKind" NOT NULL,
    "contentHash" TEXT NOT NULL,
    "simhash" BIGINT NOT NULL,
    "normalized" TEXT NOT NULL,
    "ideaId" TEXT,
    "scriptId" TEXT,
    "videoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT,
    "scriptId" TEXT,
    "channelId" TEXT,
    "status" "VideoStatus" NOT NULL DEFAULT 'CREATED',
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "title" TEXT,
    "description" TEXT,
    "tags" TEXT[],
    "hashtags" TEXT[],
    "categoryId" TEXT,
    "privacyStatus" "PrivacyStatus" NOT NULL DEFAULT 'private',
    "madeForKids" BOOLEAN NOT NULL DEFAULT false,
    "durationSeconds" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "fps" INTEGER,
    "sizeBytes" INTEGER,
    "subtitlesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "youtubeVideoId" TEXT,
    "youtubeUrl" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "performanceScore" DOUBLE PRECISION,
    "safetyVerdict" "SafetyVerdict" NOT NULL DEFAULT 'ALLOW',
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoStatusEvent" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "from" "VideoStatus",
    "to" "VideoStatus" NOT NULL,
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoScene" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "seed" INTEGER,
    "action" TEXT NOT NULL DEFAULT '',
    "voiceover" TEXT NOT NULL DEFAULT '',
    "onScreenText" TEXT,
    "camera" TEXT NOT NULL DEFAULT '',
    "mood" TEXT NOT NULL DEFAULT '',
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "status" "SceneStatus" NOT NULL DEFAULT 'PENDING',
    "providerJobId" TEXT,
    "providerName" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "assetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SceneCharacter" (
    "sceneId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "promptRevision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SceneCharacter_pkey" PRIMARY KEY ("sceneId","characterId")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "videoId" TEXT,
    "kind" "AssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "durationSeconds" DOUBLE PRECISION,
    "checksumSha256" TEXT,
    "sourceProvider" TEXT NOT NULL,
    "sourceModel" TEXT,
    "sourceReference" TEXT,
    "licenseStatus" "LicenseStatus" NOT NULL DEFAULT 'UNKNOWN',
    "licenseNote" TEXT,
    "licenseUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityReport" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "checks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualityReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "videoId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "correlationId" TEXT,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "status" "GenerationJobStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "scenesTotal" INTEGER NOT NULL DEFAULT 0,
    "scenesCompleted" INTEGER NOT NULL DEFAULT 0,
    "scenesFailed" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadJob" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "UploadJobStatus" NOT NULL DEFAULT 'PENDING',
    "privacyStatus" "PrivacyStatus" NOT NULL DEFAULT 'private',
    "publishAt" TIMESTAMP(3),
    "resumableSessionUrl" TEXT,
    "bytesUploaded" INTEGER NOT NULL DEFAULT 0,
    "bytesTotal" INTEGER,
    "youtubeVideoId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "UploadJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Berlin',
    "videosPerDay" INTEGER NOT NULL DEFAULT 1,
    "approvalMode" "ApprovalMode" NOT NULL DEFAULT 'MANUAL',
    "status" "ScheduleStatus" NOT NULL DEFAULT 'PAUSED',
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleSlot" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ScheduleSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "views" INTEGER NOT NULL,
    "likes" INTEGER NOT NULL,
    "comments" INTEGER NOT NULL,
    "averageViewDurationSeconds" DOUBLE PRECISION,
    "viewsPerHour" DOUBLE PRECISION,
    "likeRate" DOUBLE PRECISION,
    "commentRate" DOUBLE PRECISION,
    "performanceScore" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceInsight" (
    "id" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "observation" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sampleVideoIds" TEXT[],
    "sampleSize" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "generatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConfig" (
    "id" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "implementation" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "lastHealth" "HealthStatus" NOT NULL DEFAULT 'OK',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "service" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "error" TEXT,
    "videoId" TEXT,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostRecord" (
    "id" TEXT NOT NULL,
    "category" "CostCategory" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "operation" TEXT NOT NULL,
    "units" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitLabel" TEXT NOT NULL DEFAULT 'units',
    "requests" INTEGER NOT NULL DEFAULT 1,
    "estimatedMicros" INTEGER NOT NULL,
    "actualMicros" INTEGER,
    "videoId" TEXT,
    "jobId" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_youtubeChannelId_key" ON "Channel"("youtubeChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCredential_channelId_key" ON "OAuthCredential"("channelId");

-- CreateIndex
CREATE INDEX "OAuthCredential_channelId_idx" ON "OAuthCredential"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "Character_name_key" ON "Character"("name");

-- CreateIndex
CREATE INDEX "Character_isActive_idx" ON "Character"("isActive");

-- CreateIndex
CREATE INDEX "ContentIdea_status_createdAt_idx" ON "ContentIdea"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentIdea_niche_idx" ON "ContentIdea"("niche");

-- CreateIndex
CREATE INDEX "IdeaCharacter_characterId_idx" ON "IdeaCharacter"("characterId");

-- CreateIndex
CREATE INDEX "Script_ideaId_idx" ON "Script"("ideaId");

-- CreateIndex
CREATE INDEX "ContentFingerprint_kind_createdAt_idx" ON "ContentFingerprint"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ContentFingerprint_contentHash_idx" ON "ContentFingerprint"("contentHash");

-- CreateIndex
CREATE INDEX "ContentFingerprint_ideaId_idx" ON "ContentFingerprint"("ideaId");

-- CreateIndex
CREATE INDEX "ContentFingerprint_scriptId_idx" ON "ContentFingerprint"("scriptId");

-- CreateIndex
CREATE INDEX "ContentFingerprint_videoId_idx" ON "ContentFingerprint"("videoId");

-- CreateIndex
CREATE UNIQUE INDEX "Video_youtubeVideoId_key" ON "Video"("youtubeVideoId");

-- CreateIndex
CREATE INDEX "Video_status_createdAt_idx" ON "Video"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Video_channelId_publishedAt_idx" ON "Video"("channelId", "publishedAt");

-- CreateIndex
CREATE INDEX "Video_scheduledAt_idx" ON "Video"("scheduledAt");

-- CreateIndex
CREATE INDEX "VideoStatusEvent_videoId_createdAt_idx" ON "VideoStatusEvent"("videoId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VideoScene_assetId_key" ON "VideoScene"("assetId");

-- CreateIndex
CREATE INDEX "VideoScene_status_idx" ON "VideoScene"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VideoScene_videoId_index_key" ON "VideoScene"("videoId", "index");

-- CreateIndex
CREATE INDEX "SceneCharacter_characterId_idx" ON "SceneCharacter"("characterId");

-- CreateIndex
CREATE INDEX "Asset_videoId_kind_idx" ON "Asset"("videoId", "kind");

-- CreateIndex
CREATE INDEX "Asset_licenseStatus_idx" ON "Asset"("licenseStatus");

-- CreateIndex
CREATE INDEX "QualityReport_videoId_createdAt_idx" ON "QualityReport"("videoId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Job_status_runAfter_priority_idx" ON "Job"("status", "runAfter", "priority");

-- CreateIndex
CREATE INDEX "Job_type_status_idx" ON "Job"("type", "status");

-- CreateIndex
CREATE INDEX "Job_videoId_idx" ON "Job"("videoId");

-- CreateIndex
CREATE INDEX "GenerationJob_videoId_createdAt_idx" ON "GenerationJob"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationJob_status_idx" ON "GenerationJob"("status");

-- CreateIndex
CREATE INDEX "UploadJob_videoId_createdAt_idx" ON "UploadJob"("videoId", "createdAt");

-- CreateIndex
CREATE INDEX "UploadJob_status_idx" ON "UploadJob"("status");

-- CreateIndex
CREATE INDEX "UploadJob_channelId_finishedAt_idx" ON "UploadJob"("channelId", "finishedAt");

-- CreateIndex
CREATE INDEX "Schedule_status_nextRunAt_idx" ON "Schedule"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleSlot_scheduleId_dayOfWeek_hour_minute_key" ON "ScheduleSlot"("scheduleId", "dayOfWeek", "hour", "minute");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_videoId_capturedAt_idx" ON "AnalyticsSnapshot"("videoId", "capturedAt");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_capturedAt_idx" ON "AnalyticsSnapshot"("capturedAt");

-- CreateIndex
CREATE INDEX "PerformanceInsight_isActive_createdAt_idx" ON "PerformanceInsight"("isActive", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderConfig_kind_isDefault_idx" ON "ProviderConfig"("kind", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderConfig_kind_implementation_key" ON "ProviderConfig"("kind", "implementation");

-- CreateIndex
CREATE INDEX "SystemLog_level_createdAt_idx" ON "SystemLog"("level", "createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_service_createdAt_idx" ON "SystemLog"("service", "createdAt");

-- CreateIndex
CREATE INDEX "SystemLog_videoId_idx" ON "SystemLog"("videoId");

-- CreateIndex
CREATE INDEX "SystemLog_jobId_idx" ON "SystemLog"("jobId");

-- CreateIndex
CREATE INDEX "CostRecord_createdAt_idx" ON "CostRecord"("createdAt");

-- CreateIndex
CREATE INDEX "CostRecord_category_createdAt_idx" ON "CostRecord"("category", "createdAt");

-- CreateIndex
CREATE INDEX "CostRecord_videoId_idx" ON "CostRecord"("videoId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuthCredential" ADD CONSTRAINT "OAuthCredential_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaCharacter" ADD CONSTRAINT "IdeaCharacter_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ContentIdea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdeaCharacter" ADD CONSTRAINT "IdeaCharacter_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Script" ADD CONSTRAINT "Script_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ContentIdea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentFingerprint" ADD CONSTRAINT "ContentFingerprint_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ContentIdea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentFingerprint" ADD CONSTRAINT "ContentFingerprint_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentFingerprint" ADD CONSTRAINT "ContentFingerprint_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ContentIdea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoStatusEvent" ADD CONSTRAINT "VideoStatusEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoStatusEvent" ADD CONSTRAINT "VideoStatusEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoScene" ADD CONSTRAINT "VideoScene_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoScene" ADD CONSTRAINT "VideoScene_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneCharacter" ADD CONSTRAINT "SceneCharacter_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "VideoScene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SceneCharacter" ADD CONSTRAINT "SceneCharacter_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualityReport" ADD CONSTRAINT "QualityReport_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadJob" ADD CONSTRAINT "UploadJob_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadJob" ADD CONSTRAINT "UploadJob_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostRecord" ADD CONSTRAINT "CostRecord_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE SET NULL ON UPDATE CASCADE;
