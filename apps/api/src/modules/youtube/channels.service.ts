import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '@/config/app-config';
import { PrismaService } from '@/prisma/prisma.service';
import { YOUTUBE_PROVIDER } from '@/providers/provider.tokens';
import { type YouTubeProvider } from '@/providers/youtube/youtube-provider.interface';
import { EncryptionService } from '@/common/crypto/encryption';
import { generateOpaqueToken, hashToken } from '@/common/crypto/tokens';
import {
  ConflictError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '@/common/errors';
import { AuditService } from '@/modules/system/audit.service';

/**
 * Channel connection and OAuth token custody.
 *
 * Three rules govern this file:
 *   1. A refresh token is encrypted before it reaches the database and decrypted
 *      only in memory, immediately before use.
 *   2. The OAuth `state` nonce is stored hashed and single-use, so a replayed or
 *      forged callback cannot bind an attacker's channel to this installation.
 *   3. No Google password is ever seen, requested or stored.
 */

/** An authorisation left unfinished expires rather than lingering. */
const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Refresh a little early so a long upload cannot start on a nearly-dead token. */
const ACCESS_TOKEN_SKEW_MS = 5 * 60_000;

interface PendingAuthorization {
  stateHash: string;
  expiresAt: number;
  channelId: string | null;
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly encryption: EncryptionService;
  /**
   * Pending authorisations are held in memory: they live for minutes, are
   * single-use, and a lost one simply means the operator clicks "connect" again.
   */
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(YOUTUBE_PROVIDER) private readonly youtube: YouTubeProvider,
    private readonly audit: AuditService,
  ) {
    this.encryption = new EncryptionService(config.security.encryptionKey);
  }

  /** Builds the consent URL and remembers the nonce we expect back. */
  beginAuthorization(existingChannelId?: string): { url: string; state: string } {
    this.prunePending();

    const state = generateOpaqueToken(24);
    this.pending.set(hashToken(state), {
      stateHash: hashToken(state),
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
      channelId: existingChannelId ?? null,
    });

    return { url: this.youtube.getAuthorizationUrl(state), state };
  }

  /**
   * Completes the handshake.
   *
   * The state is verified and consumed before the code is exchanged, so a
   * callback that did not originate from our own redirect goes no further.
   */
  async completeAuthorization(code: string, state: string, actorId?: string) {
    this.prunePending();

    const key = hashToken(state);
    const pending = this.pending.get(key);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new UnauthenticatedError(
        'This authorisation link is invalid or has expired. Start the connection again.',
      );
    }
    this.pending.delete(key);

    const tokens = await this.youtube.authenticate(code);
    if (!tokens.refreshToken) {
      // Without a refresh token the connection dies in an hour and cannot be
      // renewed unattended — better to fail now with an actionable message.
      throw new ValidationError(
        'Google did not return a refresh token. Revoke the app’s access in your ' +
          'Google account and connect again so the consent screen is shown.',
      );
    }

    const info = await this.youtube.getChannelInfo(tokens.accessToken);

    const channel = await this.prisma.channel.upsert({
      where: { youtubeChannelId: info.channelId },
      create: {
        youtubeChannelId: info.channelId,
        title: info.title,
        handle: info.handle,
        thumbnailUrl: info.thumbnailUrl,
        description: info.description,
        defaultCategoryId: this.config.youtube.defaultCategoryId,
        defaultPrivacy: this.config.safety.defaultPrivacyStatus,
        madeForKids: this.config.youtube.madeForKids,
      },
      update: {
        title: info.title,
        handle: info.handle,
        thumbnailUrl: info.thumbnailUrl,
        description: info.description,
        isActive: true,
      },
    });

    await this.prisma.oAuthCredential.upsert({
      where: { channelId: channel.id },
      create: {
        channelId: channel.id,
        refreshTokenEnc: this.encryption.encrypt(tokens.refreshToken),
        accessTokenEnc: this.encryption.encrypt(tokens.accessToken),
        accessTokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      },
      update: {
        refreshTokenEnc: this.encryption.encrypt(tokens.refreshToken),
        accessTokenEnc: this.encryption.encrypt(tokens.accessToken),
        accessTokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      },
    });

    await this.audit.record({
      userId: actorId ?? null,
      action: 'channel.connect',
      entityType: 'Channel',
      entityId: channel.id,
      metadata: { youtubeChannelId: info.channelId, title: info.title },
    });

    this.logger.log(`Connected YouTube channel ${info.title} (${info.channelId}).`);
    return channel;
  }

  /**
   * Returns a usable access token, refreshing it when necessary.
   *
   * This is the only method that decrypts a refresh token, and the plaintext never
   * leaves the call.
   */
  async getAccessToken(channelId: string): Promise<string> {
    const credential = await this.prisma.oAuthCredential.findUnique({ where: { channelId } });
    if (!credential) {
      throw new NotFoundError('OAuth credential for channel', channelId);
    }

    const stillValid =
      credential.accessTokenEnc &&
      credential.accessTokenExpiresAt &&
      credential.accessTokenExpiresAt.getTime() - ACCESS_TOKEN_SKEW_MS > Date.now();

    if (stillValid) {
      return this.encryption.decrypt(credential.accessTokenEnc as string);
    }

    const refreshToken = this.encryption.decrypt(credential.refreshTokenEnc);
    const refreshed = await this.youtube.refreshAccessToken(refreshToken);

    await this.prisma.oAuthCredential.update({
      where: { channelId },
      data: {
        accessTokenEnc: this.encryption.encrypt(refreshed.accessToken),
        accessTokenExpiresAt: refreshed.expiresAt,
        // Google rarely rotates the refresh token, but honour it when it does.
        ...(refreshed.refreshToken && refreshed.refreshToken !== refreshToken
          ? { refreshTokenEnc: this.encryption.encrypt(refreshed.refreshToken) }
          : {}),
      },
    });

    return refreshed.accessToken;
  }

  async list() {
    return this.prisma.channel.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        credential: { select: { scopes: true, updatedAt: true, accessTokenExpiresAt: true } },
        _count: { select: { videos: true } },
      },
    });
  }

  async findById(id: string) {
    const channel = await this.prisma.channel.findUnique({
      where: { id },
      include: { credential: true },
    });
    if (!channel) throw new NotFoundError('Channel', id);
    return channel;
  }

  /** The channel used when none is specified. */
  async getDefaultChannel() {
    const channel = await this.prisma.channel.findFirst({
      where: { isActive: true, credential: { isNot: null } },
      orderBy: { createdAt: 'asc' },
    });
    if (!channel) {
      throw new ConflictError(
        'No YouTube channel is connected. Connect one under Publishing → Channels first.',
      );
    }
    return channel;
  }

  /** Revokes at Google and deletes the credential locally. */
  async disconnect(channelId: string, actorId?: string): Promise<void> {
    const credential = await this.prisma.oAuthCredential.findUnique({ where: { channelId } });
    if (credential) {
      try {
        await this.youtube.revokeToken(this.encryption.decrypt(credential.refreshTokenEnc));
      } catch (error) {
        // Local removal must still happen even if Google is unreachable.
        this.logger.warn(`Remote revocation failed for channel ${channelId}: ${String(error)}`);
      }
      await this.prisma.oAuthCredential.delete({ where: { channelId } });
    }

    await this.prisma.channel.update({ where: { id: channelId }, data: { isActive: false } });
    await this.audit.record({
      userId: actorId ?? null,
      action: 'channel.disconnect',
      entityType: 'Channel',
      entityId: channelId,
    });
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt < now) this.pending.delete(key);
    }
  }
}
