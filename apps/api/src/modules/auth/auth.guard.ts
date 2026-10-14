import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { type SessionUser, type UserRole } from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { ForbiddenError, UnauthenticatedError } from '@/common/errors';
import { safeCompare } from '@/common/crypto/encryption';
import { AuthService, type AuthenticatedSession } from './auth.service';

/** Name of the session cookie. `__Host-` in production pins it to this exact origin. */
export const SESSION_COOKIE = 'shorts_session';
export const SESSION_COOKIE_SECURE = '__Host-shorts_session';
export const CSRF_HEADER = 'x-csrf-token';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';
export const IS_INTERNAL = 'auth:internal';

/** Marks a route as reachable without a session (login, health probes). */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);

/** Restricts a route to the given roles. */
export const Roles = (...roles: UserRole[]): CustomDecorator => SetMetadata(REQUIRED_ROLES, roles);

/**
 * Marks a route as machine-to-machine: Cloud Tasks / Cloud Scheduler in
 * production, a shared secret locally. Never reachable with a user session.
 */
export const Internal = (): CustomDecorator => SetMetadata(IS_INTERNAL, true);

export interface AuthenticatedRequest extends Request {
  session?: AuthenticatedSession;
  user?: SessionUser;
}

/**
 * Session authentication, role checks and CSRF in one guard.
 *
 * Combining them is deliberate: they share the same lookup, and separating them
 * has historically produced the failure where a route is authenticated but its
 * CSRF check was forgotten.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, controller])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (this.reflector.getAllAndOverride<boolean>(IS_INTERNAL, [handler, controller])) {
      return this.authorizeInternal(request);
    }

    const token = this.readSessionCookie(request);
    if (!token) throw new UnauthenticatedError();

    const session = await this.auth.validate(token);
    if (!session) throw new UnauthenticatedError('Your session has expired. Sign in again.');

    request.session = session;
    request.user = session.user;

    // Any state-changing method needs the double-submit token; safe methods
    // do not, because they cannot be the target of a CSRF attack.
    if (!SAFE_METHODS.has(request.method)) {
      const presented = request.header(CSRF_HEADER);
      if (!this.auth.verifyCsrf(session, presented)) {
        throw new ForbiddenError('Missing or invalid CSRF token.');
      }
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(REQUIRED_ROLES, [
      handler,
      controller,
    ]);
    if (requiredRoles && requiredRoles.length > 0) {
      if (!requiredRoles.includes(session.user.role as UserRole)) {
        throw new ForbiddenError('Your role does not permit this action.');
      }
    }

    return true;
  }

  /**
   * Authorises a machine caller.
   *
   * In production these endpoints sit behind Cloud Run IAM, and Cloud Tasks
   * presents an OIDC token that the platform verifies before the request ever
   * reaches this process. The shared secret is the local-development equivalent.
   */
  private authorizeInternal(request: AuthenticatedRequest): boolean {
    const presented = request.header('x-internal-api-key');
    if (presented && safeCompare(this.config.security.internalApiKey, presented)) {
      return true;
    }

    // Cloud Run has already verified the OIDC signature and audience when this
    // header is present; re-verifying the signature here would be redundant, but
    // we do confirm it came from the service account we expect.
    const oidcEmail = request.header('x-goog-authenticated-user-email');
    const expected = this.config.gcp.tasksInvokerServiceAccount;
    if (oidcEmail && expected && oidcEmail.endsWith(expected)) {
      return true;
    }

    throw new UnauthenticatedError('This endpoint requires internal authorisation.');
  }

  private readSessionCookie(request: AuthenticatedRequest): string | undefined {
    const cookies = (request.cookies ?? {}) as Record<string, string | undefined>;
    return cookies[SESSION_COOKIE_SECURE] ?? cookies[SESSION_COOKIE];
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
