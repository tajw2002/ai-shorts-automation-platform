import {
  type ApprovalMode,
  type IdeaStatus,
  type PrivacyStatus,
  type SafetyVerdict,
  type VideoStatus,
} from '../enums';
import { type QualityReport } from '../domain/quality';
import { type DerivedMetrics, type PerformanceInsight } from '../domain/analytics';
import { type CostSummary } from '../domain/cost';
import { type ProviderDescriptor } from '../domain/system';

/** Envelope for every list endpoint. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Shape of every error the API emits. Never contains secrets or stack traces. */
export interface ApiErrorBody {
  statusCode: number;
  /** Stable machine-readable code, e.g. `VALIDATION_FAILED`, `BUDGET_EXCEEDED`. */
  code: string;
  message: string;
  /** Correlates a client-visible error with the server logs. */
  requestId: string;
  details?: unknown;
  timestamp: string;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface CharacterSummary {
  id: string;
  name: string;
  species: string;
  description: string;
  isActive: boolean;
  promptRevision: number;
  usageCount: number;
  createdAt: string;
}

export interface IdeaSummary {
  id: string;
  title: string;
  premise: string;
  hook: string;
  status: IdeaStatus;
  tone: string;
  targetDurationSeconds: number;
  characterNames: string[];
  safetyVerdict: SafetyVerdict;
  createdAt: string;
}

export interface SceneSummary {
  id: string;
  index: number;
  prompt: string;
  voiceover: string;
  durationSeconds: number;
  status: string;
  assetUrl: string | null;
}

export interface VideoSummary {
  id: string;
  title: string | null;
  status: VideoStatus;
  thumbnailUrl: string | null;
  previewUrl: string | null;
  durationSeconds: number | null;
  channelName: string | null;
  youtubeVideoId: string | null;
  youtubeUrl: string | null;
  privacyStatus: PrivacyStatus | null;
  createdAt: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  performanceScore: number | null;
  lastError: string | null;
}

export interface VideoDetail extends VideoSummary {
  description: string | null;
  tags: string[];
  hashtags: string[];
  ideaId: string | null;
  scriptId: string | null;
  narration: string | null;
  scenes: SceneSummary[];
  qualityReport: QualityReport | null;
  safetyVerdict: SafetyVerdict | null;
  metrics: DerivedMetrics | null;
  costMicros: number;
  statusHistory: Array<{ status: VideoStatus; at: string; note: string | null }>;
}

export interface DashboardStats {
  videosGenerated: number;
  videosPublished: number;
  videosInQueue: number;
  videosAwaitingReview: number;
  failedJobs24h: number;
  uploadsToday: number;
  uploadsRemainingToday: number;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  averageViewDurationSeconds: number | null;
  cost: CostSummary;
  operational: {
    emergencyStop: boolean;
    generationPaused: boolean;
    uploadsPaused: boolean;
    autoPublish: boolean;
    requireApproval: boolean;
    dryRun: boolean;
    approvalMode: ApprovalMode;
  };
  topVideos: VideoSummary[];
  recentErrors: Array<{
    id: string;
    at: string;
    service: string;
    message: string;
    videoId: string | null;
  }>;
}

export interface AnalyticsOverview {
  totals: { views: number; likes: number; comments: number; published: number };
  series: Array<{ date: string; views: number; likes: number; comments: number }>;
  topVideos: VideoSummary[];
  insights: PerformanceInsight[];
  insightsGeneratedAt: string | null;
}

export interface ProvidersOverview {
  providers: ProviderDescriptor[];
  dryRun: boolean;
}
