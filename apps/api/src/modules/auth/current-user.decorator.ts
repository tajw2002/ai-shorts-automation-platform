import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type SessionUser } from '@shorts/contracts';
import { UnauthenticatedError } from '@/common/errors';
import { type AuthenticatedRequest } from './auth.guard';

/**
 * Injects the authenticated user.
 *
 * Throws rather than returning undefined: a handler asking for the current user
 * on a route that turned out to be public is a bug, and should not silently
 * produce an audit entry with a null actor.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthenticatedError('No authenticated user is attached to this request.');
    }
    return request.user;
  },
);
