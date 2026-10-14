'use client';

/**
 * Browser-side API client.
 *
 * Always goes through the Next proxy, so the request is same-origin and the
 * session cookie travels automatically. The CSRF token is read from the copy the
 * login response put in `sessionStorage` and echoed in a header, completing the
 * double-submit pair the API expects.
 */

const CSRF_STORAGE_KEY = 'shorts.csrf';

export class ClientApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ClientApiError';
  }
}

export function setCsrfToken(token: string): void {
  try {
    sessionStorage.setItem(CSRF_STORAGE_KEY, token);
  } catch {
    // Private browsing can block storage; the next page load re-fetches the token.
  }
}

export function getCsrfToken(): string | null {
  try {
    return sessionStorage.getItem(CSRF_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  if (method !== 'GET' && method !== 'HEAD') {
    let token = getCsrfToken();
    // A reload clears sessionStorage; recover the token rather than failing the
    // action with a confusing 403.
    if (!token) token = await refreshCsrfToken();
    if (token) headers['x-csrf-token'] = token;
  }

  const response = await fetch(`/api/proxy${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 401) {
    window.location.href = '/login';
    throw new ClientApiError(401, 'UNAUTHENTICATED', 'Your session has expired.');
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      message?: string;
      details?: unknown;
    } | null;
    throw new ClientApiError(
      response.status,
      payload?.code ?? 'UNKNOWN',
      payload?.message ?? `Request failed with status ${response.status}.`,
      payload?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function refreshCsrfToken(): Promise<string | null> {
  try {
    const response = await fetch('/api/proxy/auth/me');
    if (!response.ok) return null;
    const payload = (await response.json()) as { csrfToken?: string };
    if (payload.csrfToken) {
      setCsrfToken(payload.csrfToken);
      return payload.csrfToken;
    }
  } catch {
    // Fall through: the caller will surface the resulting 403.
  }
  return null;
}
