import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Server-side API access.
 *
 * Server components talk to the API directly (container-to-container in
 * production), forwarding the operator's session cookie. The browser never calls
 * the API host itself — it goes through the proxy route — so there is exactly one
 * origin in play and no cross-site cookie configuration to get wrong.
 */

/** Reachable from the server. In Docker this is the service name, not localhost. */
const API_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Redirect to the login page on a 401 instead of throwing. Defaults to true. */
  redirectOnUnauthorized?: boolean;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const cookieStore = await cookies();
  const { body, redirectOnUnauthorized = true, ...init } = options;

  const response = await fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    headers: {
      cookie: cookieStore.toString(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    // Operations data is never stale-tolerable: a cached queue view would show
    // an operator work that has already been handled.
    cache: 'no-store',
  });

  if (response.status === 401 && redirectOnUnauthorized) {
    redirect('/login');
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string;
      details?: unknown;
    } | null;

    throw new ApiError(
      response.status,
      payload?.code ?? 'UNKNOWN',
      payload?.message ?? `Request failed with status ${response.status}.`,
      payload?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Fetches without failing the page.
 *
 * A dashboard that renders nothing because one panel's endpoint is down is worse
 * than one that renders eleven panels and an error in the twelfth.
 */
export async function apiFetchSafe<T>(
  path: string,
  fallback: T,
  options: ApiFetchOptions = {},
): Promise<{ data: T; error: string | null }> {
  try {
    return { data: await apiFetch<T>(path, options), error: null };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    return {
      data: fallback,
      error: error instanceof Error ? error.message : 'Request failed.',
    };
  }
}

export { API_URL };
