import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { loginSchema, type LoginDto, type SessionUser } from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import {
  Public,
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
  type AuthenticatedRequest,
} from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthService } from './auth.service';

/**
 * Session endpoints.
 *
 * The session token is delivered only as an httpOnly cookie — never in a response
 * body — so a cross-site script cannot read it. The CSRF token *is* returned in
 * the body, because the client must be able to echo it back in a header; that
 * asymmetry is what makes the double-submit pattern work.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zodBody(loginSchema)) dto: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: SessionUser; csrfToken: string }> {
    const { token, session } = await this.auth.login(dto.email, dto.password, {
      ipAddress: request.ip,
      userAgent: request.header('user-agent'),
    });

    response.cookie(this.cookieName(), token, this.cookieOptions());
    return { user: session.user, csrfToken: session.csrfSecret };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    const token = cookies[SESSION_COOKIE_SECURE] ?? cookies[SESSION_COOKIE];
    if (token) await this.auth.logout(token);
    response.clearCookie(this.cookieName(), { ...this.cookieOptions(), maxAge: undefined });
  }

  /** Returns the current user and a fresh CSRF token — used to rehydrate a reload. */
  @Get('me')
  me(
    @CurrentUser() user: SessionUser,
    @Req() request: AuthenticatedRequest,
  ): { user: SessionUser; csrfToken: string } {
    return { user, csrfToken: request.session?.csrfSecret ?? '' };
  }

  /**
   * `__Host-` prefix in production: the browser then refuses the cookie unless it
   * is Secure, path `/`, and has no Domain attribute — which pins it to this exact
   * origin and blocks subdomain injection. It requires HTTPS, so plain-HTTP local
   * development uses the unprefixed name.
   */
  private cookieName(): string {
    return this.config.app.isProduction ? SESSION_COOKIE_SECURE : SESSION_COOKIE;
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.app.isProduction,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: this.config.security.sessionTtlMs,
    };
  }
}
