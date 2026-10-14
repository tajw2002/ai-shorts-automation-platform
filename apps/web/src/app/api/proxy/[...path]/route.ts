import { type NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/api';

/**
 * Browser → API proxy.
 *
 * Everything the browser sends goes through here rather than directly to the API
 * host. That has one significant benefit: the session cookie belongs to a single
 * origin — the dashboard's — so it needs no `Domain` attribute, no cross-site
 * relaxation of `SameSite`, and the `__Host-` prefix works in production.
 *
 * The proxy is intentionally dumb. It forwards the method, body, cookies and the
 * CSRF header, and passes `Set-Cookie` back. It makes no authorisation decisions
 * of its own: the API is the only authority on who may do what.
 */

/**
 * Headers safe to forward upstream. Everything else is dropped.
 *
 * `range` matters for video previews: Safari will not play a `<video>` unless its
 * `Range: bytes=0-1` probe is answered with a 206.
 */
const FORWARD_REQUEST_HEADERS = ['content-type', 'cookie', 'x-csrf-token', 'accept', 'range'];
/** Headers safe to return downstream. */
const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'cache-control',
  'accept-ranges',
  'content-range',
];

async function handle(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  const search = request.nextUrl.search;
  const target = `${API_URL}/api/v1/${path.map(encodeURIComponent).join('/')}${search}`;

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.text() : undefined,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    // The API being unreachable is an infrastructure problem, not a client error.
    return NextResponse.json(
      { code: 'API_UNREACHABLE', message: 'The API could not be reached.' },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  // Only when the body reaches the browser byte-for-byte: fetch() decodes a
  // compressed upstream body, which would make the original length wrong.
  const length = upstream.headers.get('content-length');
  if (length && !upstream.headers.get('content-encoding')) {
    responseHeaders.set('content-length', length);
  }

  // Session cookies are set by the API and must reach the browser attributed to
  // this origin. getSetCookie() preserves multiple cookies, which a plain get()
  // would collapse into one malformed header.
  for (const cookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', cookie);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;

/** Proxying must never be statically optimised or cached. */
export const dynamic = 'force-dynamic';
