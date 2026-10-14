import { Injectable, Logger } from '@nestjs/common';
import { google, type youtube_v3 } from 'googleapis';
import { createReadStream } from 'node:fs';
import { type PrivacyStatus } from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { ProviderError, ProviderNotConfiguredError, UploadFailedError } from '@/common/errors';
import { withRetry } from '@/common/resilience';
import { errorHealth, okHealth, type ProviderHealth } from '../provider.types';
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
 * Google/YouTube adapter.
 *
 * Scopes are the minimum needed to publish to a channel the operator owns and to
 * read that channel's own statistics. Notably absent: anything that would let the
 * platform touch another account, comment, subscribe or rate. YouTube's rules on
 * fake engagement are enforced by never requesting the capability at all.
 */
/** googleapis bundles its own google-auth-library, so take the type from there. */
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

const RESUMABLE_ENDPOINT =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

/** 8 MiB — a multiple of 256 KiB, which the resumable protocol requires. */
const CHUNK_SIZE = 8 * 1024 * 1024;

@Injectable()
export class GoogleYouTubeProvider implements YouTubeProvider {
  readonly name = 'google';
  private readonly logger = new Logger(GoogleYouTubeProvider.name);

  constructor(private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!this.config.youtube.clientId) missing.push('YOUTUBE_CLIENT_ID');
    if (!this.config.youtube.clientSecret) missing.push('YOUTUBE_CLIENT_SECRET');
    if (!this.config.youtube.redirectUri) missing.push('YOUTUBE_REDIRECT_URI');
    return missing;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const missing = this.missingConfiguration();
    if (missing.length > 0) return errorHealth(`Not configured. Missing: ${missing.join(', ')}`);
    // Without a connected channel there is nothing to probe that does not need
    // user credentials, so report configuration validity rather than pretend.
    return okHealth('OAuth client configured. Connect a channel to verify access.', null);
  }

  describe(): Record<string, string | number | boolean | null> {
    return {
      redirectUri: this.config.youtube.redirectUri,
      scopes: SCOPES.join(' '),
      defaultCategoryId: this.config.youtube.defaultCategoryId,
      chunkSizeBytes: CHUNK_SIZE,
    };
  }

  getAuthorizationUrl(state: string): string {
    return this.oauthClient().generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      state,
      // Forcing the consent screen is what guarantees a refresh token comes back
      // on a re-authorisation; without it Google may omit one.
      prompt: 'consent',
      include_granted_scopes: true,
    });
  }

  async authenticate(code: string): Promise<OAuthTokens> {
    const client = this.oauthClient();
    try {
      const { tokens } = await client.getToken(code);
      if (!tokens.access_token) {
        throw new ProviderError({
          provider: this.name,
          message: 'Token exchange returned no access token.',
        });
      }
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3_600_000),
        scopes: tokens.scope ? tokens.scope.split(' ') : SCOPES,
      };
    } catch (error) {
      throw this.toProviderError(error, 'authenticate', false);
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const client = this.oauthClient();
    client.setCredentials({ refresh_token: refreshToken });
    try {
      const { credentials } = await client.refreshAccessToken();
      if (!credentials.access_token) {
        throw new ProviderError({
          provider: this.name,
          message: 'Refresh returned no access token.',
        });
      }
      return {
        accessToken: credentials.access_token,
        // Google usually omits the refresh token on refresh; keep the existing one.
        refreshToken: credentials.refresh_token ?? refreshToken,
        expiresAt: new Date(credentials.expiry_date ?? Date.now() + 3_600_000),
        scopes: credentials.scope ? credentials.scope.split(' ') : SCOPES,
      };
    } catch (error) {
      throw this.toProviderError(error, 'refreshAccessToken', false);
    }
  }

  async revokeToken(token: string): Promise<void> {
    try {
      await this.oauthClient().revokeToken(token);
    } catch (error) {
      // A token that is already invalid is the desired end state, so this is a
      // warning rather than a failure.
      this.logger.warn(`Token revocation failed: ${String(error)}`);
    }
  }

  async getChannelInfo(accessToken: string): Promise<ChannelInfo> {
    const api = this.youtubeApi(accessToken);
    const response = await api.channels.list({ part: ['snippet'], mine: true });
    const channel = response.data.items?.[0];
    if (!channel?.id) {
      throw new ProviderError({
        provider: this.name,
        message: 'The authorised account has no YouTube channel.',
      });
    }
    return {
      channelId: channel.id,
      title: channel.snippet?.title ?? 'Untitled channel',
      handle: channel.snippet?.customUrl ?? null,
      thumbnailUrl: channel.snippet?.thumbnails?.default?.url ?? null,
      description: channel.snippet?.description ?? null,
    };
  }

  /**
   * Resumable upload, implemented against the protocol directly.
   *
   * The SDK's convenience wrapper hides the session URI, which is exactly the
   * value that has to survive a process restart for a retry to continue instead
   * of re-sending a 100 MB file. So: initiate, remember the URI, upload in
   * chunks, and on resume ask the server how much it already has.
   */
  async uploadVideo(request: UploadRequest): Promise<UploadResult> {
    const sessionUrl = request.resumeSessionUrl ?? (await this.initiateResumableUpload(request));

    let offset = request.resumeSessionUrl
      ? await this.queryUploadOffset(sessionUrl, request.sizeBytes)
      : 0;

    if (offset >= request.sizeBytes) {
      // The server already has every byte; ask it for the final status.
      offset = request.sizeBytes;
    }

    while (offset < request.sizeBytes) {
      const end = Math.min(offset + CHUNK_SIZE, request.sizeBytes) - 1;
      const chunk = await this.readChunk(request.filePath, offset, end);

      const response = await fetch(sessionUrl, {
        method: 'PUT',
        headers: {
          'content-length': String(chunk.length),
          'content-range': `bytes ${offset}-${end}/${request.sizeBytes}`,
        },
        body: new Uint8Array(chunk),
        signal: request.signal ?? null,
      });

      if (response.status === 308) {
        offset = parseRangeHeader(response.headers.get('range')) ?? end + 1;
        request.onProgress?.(offset, sessionUrl);
        continue;
      }

      if (response.ok) {
        const body = (await response.json()) as youtube_v3.Schema$Video;
        request.onProgress?.(request.sizeBytes, sessionUrl);
        if (!body.id) {
          throw new UploadFailedError('YouTube accepted the upload but returned no video id.');
        }
        return {
          youtubeVideoId: body.id,
          url: `https://www.youtube.com/shorts/${body.id}`,
          uploadStatus: body.status?.uploadStatus ?? 'uploaded',
          privacyStatus:
            (body.status?.privacyStatus as PrivacyStatus) ?? request.metadata.privacyStatus,
          simulated: false,
        };
      }

      const detail = await response.text().catch(() => '');
      throw new UploadFailedError(
        `Chunk upload failed with HTTP ${response.status}: ${detail.slice(0, 300)}`,
        // 5xx and 429 are worth resuming; a 4xx means the request itself is wrong.
        response.status >= 500 || response.status === 429,
      );
    }

    throw new UploadFailedError('Upload loop completed without a final response.', true);
  }

  async updateVideo(
    accessToken: string,
    youtubeVideoId: string,
    metadata: Partial<UploadMetadata>,
  ): Promise<void> {
    const api = this.youtubeApi(accessToken);
    // `videos.update` replaces whole parts, so the current values are read first
    // and merged — otherwise updating a title would blank the description.
    const current = await api.videos.list({ part: ['snippet', 'status'], id: [youtubeVideoId] });
    const existing = current.data.items?.[0];
    if (!existing) {
      throw new ProviderError({
        provider: this.name,
        message: `Video ${youtubeVideoId} was not found on the channel.`,
      });
    }

    await api.videos.update({
      part: ['snippet', 'status'],
      requestBody: {
        id: youtubeVideoId,
        snippet: {
          ...existing.snippet,
          title: metadata.title ?? existing.snippet?.title,
          description: metadata.description ?? existing.snippet?.description,
          tags: metadata.tags ?? existing.snippet?.tags,
          categoryId: metadata.categoryId ?? existing.snippet?.categoryId,
        },
        status: {
          ...existing.status,
          privacyStatus: metadata.privacyStatus ?? existing.status?.privacyStatus,
          selfDeclaredMadeForKids:
            metadata.madeForKids ?? existing.status?.selfDeclaredMadeForKids ?? false,
          ...(metadata.publishAt !== undefined
            ? { publishAt: metadata.publishAt?.toISOString() ?? null }
            : {}),
        },
      },
    });
  }

  async scheduleVideo(
    accessToken: string,
    youtubeVideoId: string,
    publishAt: Date | null,
    privacyStatus: PrivacyStatus,
  ): Promise<void> {
    // YouTube only honours publishAt while the video is private; sending a
    // schedule with a public status silently publishes immediately instead.
    await this.updateVideo(accessToken, youtubeVideoId, {
      publishAt,
      privacyStatus: publishAt ? 'private' : privacyStatus,
    });
  }

  async getVideoAnalytics(
    accessToken: string,
    youtubeVideoIds: string[],
  ): Promise<VideoStatistics[]> {
    if (youtubeVideoIds.length === 0) return [];
    const api = this.youtubeApi(accessToken);
    const results: VideoStatistics[] = [];

    // videos.list accepts at most 50 ids per call.
    for (let i = 0; i < youtubeVideoIds.length; i += 50) {
      const batch = youtubeVideoIds.slice(i, i + 50);
      const response = await withRetry(() => api.videos.list({ part: ['statistics'], id: batch }), {
        attempts: 3,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        jitter: true,
      });

      for (const item of response.data.items ?? []) {
        if (!item.id) continue;
        results.push({
          youtubeVideoId: item.id,
          views: Number(item.statistics?.viewCount ?? 0),
          likes: Number(item.statistics?.likeCount ?? 0),
          comments: Number(item.statistics?.commentCount ?? 0),
          // Average view duration lives in the Analytics API, which reports on a
          // delay and per-channel; it is filled in by the analytics module when
          // available rather than guessed here.
          averageViewDurationSeconds: null,
        });
      }
    }
    return results;
  }

  // -- internals ------------------------------------------------------------

  private oauthClient(): OAuth2Client {
    // The type is taken from `google.auth.OAuth2` rather than imported from
    // google-auth-library directly: googleapis bundles its own copy of that
    // package, and the two nominal types are not assignable to each other.
    const missing = this.missingConfiguration();
    if (missing.length > 0) throw new ProviderNotConfiguredError('YOUTUBE', this.name, missing);
    return new google.auth.OAuth2(
      this.config.youtube.clientId,
      this.config.youtube.clientSecret,
      this.config.youtube.redirectUri,
    );
  }

  private youtubeApi(accessToken: string): youtube_v3.Youtube {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return google.youtube({ version: 'v3', auth });
  }

  private async initiateResumableUpload(request: UploadRequest): Promise<string> {
    const body: youtube_v3.Schema$Video = {
      snippet: {
        title: request.metadata.title,
        description: request.metadata.description,
        tags: request.metadata.tags,
        categoryId: request.metadata.categoryId,
      },
      status: {
        privacyStatus: request.metadata.privacyStatus,
        selfDeclaredMadeForKids: request.metadata.madeForKids,
        ...(request.metadata.publishAt
          ? { publishAt: request.metadata.publishAt.toISOString() }
          : {}),
        // Required disclosure for AI-generated material.
        containsSyntheticMedia: request.metadata.containsSyntheticMedia,
      },
    };

    const response = await fetch(RESUMABLE_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(request.sizeBytes),
        'x-upload-content-type': 'video/mp4',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new UploadFailedError(
        `Could not start a resumable upload (HTTP ${response.status}): ${detail.slice(0, 300)}`,
        response.status >= 500 || response.status === 429,
      );
    }

    const sessionUrl = response.headers.get('location');
    if (!sessionUrl) {
      throw new UploadFailedError('Resumable upload started without a session URL.', true);
    }
    return sessionUrl;
  }

  /** Asks the server how many bytes it already holds for this session. */
  private async queryUploadOffset(sessionUrl: string, totalBytes: number): Promise<number> {
    const response = await fetch(sessionUrl, {
      method: 'PUT',
      headers: { 'content-range': `bytes */${totalBytes}`, 'content-length': '0' },
    });

    if (response.status === 308) {
      return parseRangeHeader(response.headers.get('range')) ?? 0;
    }
    if (response.ok) return totalBytes;

    throw new UploadFailedError(
      `Could not resume upload session (HTTP ${response.status}).`,
      response.status >= 500,
    );
  }

  private readChunk(filePath: string, start: number, end: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = createReadStream(filePath, { start, end });
      stream.on('data', (chunk) => chunks.push(chunk as Buffer));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  private toProviderError(error: unknown, operation: string, retryable: boolean): Error {
    if (error instanceof ProviderError) return error;
    return new ProviderError({
      provider: this.name,
      message: `${operation}: ${error instanceof Error ? error.message : 'unknown failure'}`,
      retryable,
      cause: error,
    });
  }
}

/**
 * `Range: bytes=0-262143` means the server holds bytes 0..262143, so the next
 * byte to send is 262144. Absent header means nothing has been stored yet.
 */
export function parseRangeHeader(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null;
  const match = /bytes=(\d+)-(\d+)/.exec(rangeHeader);
  if (!match?.[2]) return null;
  return Number(match[2]) + 1;
}
