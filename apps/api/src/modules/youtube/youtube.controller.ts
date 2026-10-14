import { Body, Controller, Delete, Get, Param, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  schedulePublishSchema,
  type SchedulePublishDto,
  type SessionUser,
} from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { Public, Roles } from '@/modules/auth/auth.guard';
import { CurrentUser } from '@/modules/auth/current-user.decorator';
import { ValidationError } from '@/common/errors';
import { ChannelsService } from './channels.service';
import { PublishingService } from './publishing.service';
import { PublishGuardService } from './publish-guard.service';

@ApiTags('publishing')
@Controller()
export class YouTubeController {
  constructor(
    private readonly config: AppConfig,
    private readonly channels: ChannelsService,
    private readonly publishing: PublishingService,
    private readonly guard: PublishGuardService,
  ) {}

  /* -- Channels ----------------------------------------------------------- */

  @Get('channels')
  listChannels() {
    return this.channels.list();
  }

  @Post('channels/connect')
  @Roles('ADMIN')
  connect() {
    // Returns the consent URL rather than redirecting, so the dashboard controls
    // the navigation and can warn the operator first.
    return this.channels.beginAuthorization();
  }

  /**
   * OAuth callback.
   *
   * Public because Google redirects the browser here without our cookie in a
   * cross-site context; the `state` nonce is what authenticates the request.
   * On completion the user is bounced back to the dashboard.
   */
  @Public()
  @Get('youtube/oauth/callback')
  async oauthCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const dashboard = `${this.config.app.webBaseUrl}/publishing`;

    if (error) {
      response.redirect(`${dashboard}?connection=denied`);
      return;
    }
    if (!code || !state) {
      response.redirect(`${dashboard}?connection=invalid`);
      return;
    }

    try {
      const channel = await this.channels.completeAuthorization(code, state);
      response.redirect(
        `${dashboard}?connection=success&channel=${encodeURIComponent(channel.title)}`,
      );
    } catch (failure) {
      // The reason is logged server-side; the URL carries only a coarse status so
      // an error message cannot be reflected into the page.
      response.redirect(`${dashboard}?connection=failed`);
      void failure;
    }
  }

  @Delete('channels/:id')
  @Roles('ADMIN')
  async disconnect(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.channels.disconnect(id, user.id);
    return { disconnected: true };
  }

  /* -- Publishing --------------------------------------------------------- */

  /** Explains whether a video may be published, and why not if it may not. */
  @Get('videos/:id/publish-check')
  check(@Param('id') id: string) {
    return this.guard.evaluate(id);
  }

  @Post('videos/:id/publish')
  @Roles('ADMIN', 'EDITOR')
  async publish(
    @Param('id') id: string,
    @Body(zodBody(schedulePublishSchema)) dto: SchedulePublishDto,
    @CurrentUser() user: SessionUser,
  ) {
    const publishAt = dto.publishAt ? new Date(dto.publishAt) : null;
    if (publishAt && Number.isNaN(publishAt.getTime())) {
      throw new ValidationError('publishAt must be a valid ISO 8601 timestamp.');
    }

    return this.publishing.schedule(id, {
      channelId: dto.channelId,
      publishAt,
      privacyStatus: dto.privacyStatus,
      actorId: user.id,
    });
  }

  @Post('videos/:id/publish/cancel')
  @Roles('ADMIN', 'EDITOR')
  async cancelPublish(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.publishing.cancel(id, user.id);
    return { cancelled: true };
  }
}
