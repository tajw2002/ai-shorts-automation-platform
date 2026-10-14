import { type PrivacyStatus } from '@shorts/contracts';
import { type BaseProvider } from '../provider.types';

/**
 * The YouTube port.
 *
 * Deliberately narrow: it can authenticate a channel the operator owns, publish
 * to it, and read that channel's own statistics. It has no capability to download
 * or repost anyone else's content, and no capability to interact with other
 * accounts. The copyright and platform rules are enforced by the shape of this
 * interface, not only by policy.
 */

export interface OAuthTokens {
  accessToken: string;
  /** Absent when the user has authorised before and Google withholds a new one. */
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

export interface ChannelInfo {
  channelId: string;
  title: string;
  handle: string | null;
  thumbnailUrl: string | null;
  description: string | null;
}

export interface UploadMetadata {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: PrivacyStatus;
  /**
   * Scheduled publication. YouTube only honours this when `privacyStatus` is
   * `private` at upload time.
   */
  publishAt: Date | null;
  /** COPPA declaration. Required on every upload; never guessed. */
  madeForKids: boolean;
  /** Required for AI-generated content in many jurisdictions and by YouTube policy. */
  containsSyntheticMedia: boolean;
}

export interface UploadRequest {
  accessToken: string;
  /** Path on local disk. Uploads stream from the file, never from memory. */
  filePath: string;
  sizeBytes: number;
  metadata: UploadMetadata;
  /** Resume a previously interrupted upload instead of starting over. */
  resumeSessionUrl?: string;
  onProgress?: (bytesUploaded: number, sessionUrl: string) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  youtubeVideoId: string;
  url: string;
  /** YouTube's own processing state right after the upload completes. */
  uploadStatus: string;
  privacyStatus: PrivacyStatus;
  /** True when DRY_RUN meant nothing was actually sent. */
  simulated: boolean;
}

export interface VideoStatistics {
  youtubeVideoId: string;
  views: number;
  likes: number;
  comments: number;
  /** Only available through the Analytics API for owned channels. */
  averageViewDurationSeconds: number | null;
}

export interface YouTubeProvider extends BaseProvider {
  /** Builds the consent URL. `state` is a nonce we verify on the callback. */
  getAuthorizationUrl(state: string): string;
  /** Completes the authorization-code exchange. */
  authenticate(code: string): Promise<OAuthTokens>;
  refreshAccessToken(refreshToken: string): Promise<OAuthTokens>;
  revokeToken(token: string): Promise<void>;
  getChannelInfo(accessToken: string): Promise<ChannelInfo>;
  /** Resumable by contract — see `resumeSessionUrl` on the request. */
  uploadVideo(request: UploadRequest): Promise<UploadResult>;
  updateVideo(
    accessToken: string,
    youtubeVideoId: string,
    metadata: Partial<UploadMetadata>,
  ): Promise<void>;
  /** Sets or clears a scheduled publication time on an already-uploaded video. */
  scheduleVideo(
    accessToken: string,
    youtubeVideoId: string,
    publishAt: Date | null,
    privacyStatus: PrivacyStatus,
  ): Promise<void>;
  getVideoAnalytics(accessToken: string, youtubeVideoIds: string[]): Promise<VideoStatistics[]>;
}
