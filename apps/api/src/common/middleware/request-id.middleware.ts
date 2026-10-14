import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Assigns a request id and echoes it back.
 *
 * Deliberately middleware rather than an interceptor. Nest runs
 * middleware → guards → interceptors, so an interceptor never executes for a
 * request rejected by a guard — which is precisely when a user is most likely to
 * report an error and need an id to quote. As middleware, every response carries
 * one, including 401s and 429s.
 *
 * An inbound `x-request-id` is honoured so a trace started by a load balancer or
 * the dashboard survives into our logs.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(request: Request & { id?: string }, response: Response, next: NextFunction): void {
    const inbound = request.headers['x-request-id'];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    // A client-supplied value goes into logs and response headers, so it is
    // length-capped and stripped of anything that could forge a log line.
    request.id = sanitizeRequestId(candidate) ?? randomUUID();
    response.setHeader('x-request-id', request.id);
    next();
  }
}

export function sanitizeRequestId(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  return cleaned.length >= 8 ? cleaned : null;
}
