import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type PrivacyStatus } from '@shorts/contracts';
import { okHealth, type ProviderHealth } from '../provider.types';
import {
  type ChannelInfo,
  type OAuthTokens,
  type UploadMetadata,
  type UploadRequest,
  type UploadResult,
  type VideoStatistics,
  type YouTubeProvider,
} from './youtube-provider.interface';

/**
 * Simulated YouTube integration.
 *
 * This adapter is what makes DRY_RUN safe: it exercises the full publish path —
 * guards, quotas, upload job bookkeeping, progress callbacks, analytics polling —
 * without a single byte leaving the machine. It is wired in automatically
 * whenever DRY_RUN is true, so a misconfiguration cannot cause an accidental
 * public upload.
 */
@Injectable()
export class MockYouTubeProvider implements YouTubeProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockYouTubeProvider.name);
  private readonly uploads = new Map<string, { metadata: UploadMetadata; publishedAt: Date }>();

  isConfigured(): boolean {
    return true;
  }

  missingConfiguration(): string[] {
    return [];
  }

  async healthCheck(): Promise<ProviderHealth> {
    return okHealth('Mock YouTube provider — no uploads leave this machine.', 0);
  }

  describe(): Record<string, string | number | boolean | null> {
    return { simulated: true, uploadsPerformed: this.uploads.size };
  }

  getAuthorizationUrl(state: string): string {
    return `https://example.invalid/mock-oauth?state=${encodeURIComponent(state)}`;
  }

  async authenticate(code: string): Promise<OAuthTokens> {
    return {
      accessToken: `mock-access-${code.slice(0, 8)}`,
      refreshToken: `mock-refresh-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    return {
      accessToken: `mock-access-${refreshToken.slice(-8)}`,
      refreshToken,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    };
  }

  async revokeToken(): Promise<void> {
    /* nothing to revoke */
  }

  async getChannelInfo(): Promise<ChannelInfo> {
    return {
      channelId: 'UC-mock-channel-000000',
      title: 'Mock Channel (dry run)',
      handle: '@mock-channel',
      thumbnailUrl: null,
      description: 'Simulated channel used while DRY_RUN is enabled.',
    };
  }

  async uploadVideo(request: UploadRequest): Promise<UploadResult> {
    const youtubeVideoId = `mock_${randomUUID().replace(/-/g, '').slice(0, 11)}`;

    // Emit progress so the dashboard's upload UI is exercised too.
    const sessionUrl = `https://example.invalid/mock-resumable/${youtubeVideoId}`;
    if (request.onProgress) {
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        request.onProgress(Math.round(request.sizeBytes * fraction), sessionUrl);
      }
    }

    this.uploads.set(youtubeVideoId, { metadata: request.metadata, publishedAt: new Date() });
    this.logger.log(
      `DRY RUN: simulated upload of ${request.filePath} (${request.sizeBytes} bytes) as ${youtubeVideoId}`,
    );

    return {
      youtubeVideoId,
      url: `https://www.youtube.com/shorts/${youtubeVideoId}`,
      uploadStatus: 'uploaded',
      privacyStatus: request.metadata.privacyStatus,
      simulated: true,
    };
  }

  async updateVideo(
    _accessToken: string,
    youtubeVideoId: string,
    metadata: Partial<UploadMetadata>,
  ): Promise<void> {
    const existing = this.uploads.get(youtubeVideoId);
    if (existing) Object.assign(existing.metadata, metadata);
  }

  async scheduleVideo(
    _accessToken: string,
    youtubeVideoId: string,
    publishAt: Date | null,
    privacyStatus: PrivacyStatus,
  ): Promise<void> {
    const existing = this.uploads.get(youtubeVideoId);
    if (existing) {
      existing.metadata.publishAt = publishAt;
      existing.metadata.privacyStatus = privacyStatus;
    }
  }

  async getVideoAnalytics(
    _accessToken: string,
    youtubeVideoIds: string[],
  ): Promise<VideoStatistics[]> {
    // Deterministic pseudo-growth so analytics charts have something to show.
    return youtubeVideoIds.map((id) => {
      const upload = this.uploads.get(id);
      const hours = upload
        ? Math.max(1, (Date.now() - upload.publishedAt.getTime()) / 3_600_000)
        : 1;
      const seed = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      const views = Math.round(hours * (10 + (seed % 90)));
      return {
        youtubeVideoId: id,
        views,
        likes: Math.round(views * 0.04),
        comments: Math.round(views * 0.005),
        averageViewDurationSeconds: 12 + (seed % 20),
      };
    });
  }
}
