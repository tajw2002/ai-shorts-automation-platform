import { ProviderError } from '../errors';

/**
 * Body types Node's global `fetch` accepts. Derived from the runtime's own
 * `RequestInit` rather than the DOM lib, so we do not pull browser globals into
 * a server-side type space.
 */
export type HttpBody = NonNullable<RequestInit['body']>;
import { withRetry, withTimeout, type RetryOptions } from './retry';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** Serialised as JSON unless `rawBody` is used. */
  body?: unknown;
  rawBody?: HttpBody;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  /** Treated as success even though the status is not 2xx (e.g. 308 for resumable uploads). */
  acceptStatuses?: number[];
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

/**
 * Status codes worth retrying: transient server-side conditions and the two 4xx
 * codes that explicitly mean "come back later".
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Honours `Retry-After` when the server sends one, in either of its two forms.
 * Returns null when absent or unparseable.
 */
export function parseRetryAfter(headerValue: string | null, now = Date.now()): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(headerValue);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/**
 * A small, dependency-free HTTP client with the behaviour every adapter needs:
 * timeout, bounded retries, rate-limit awareness and typed provider errors.
 *
 * Adapters use this instead of calling `fetch` directly so error handling is
 * uniform and testable.
 */
export class ProviderHttpClient {
  constructor(
    private readonly provider: string,
    private readonly defaults: {
      baseUrl?: string;
      headers?: Record<string, string>;
      timeoutMs: number;
      retry?: Partial<RetryOptions>;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async request<T = unknown>(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const url = this.resolveUrl(path);
    const timeoutMs = options.timeoutMs ?? this.defaults.timeoutMs;
    const fetchImpl = this.defaults.fetchImpl ?? fetch;
    const accept = new Set(options.acceptStatuses ?? []);

    return withRetry(
      async () => {
        const controller = new AbortController();
        const headers: Record<string, string> = {
          ...(this.defaults.headers ?? {}),
          ...(options.headers ?? {}),
        };

        let body: HttpBody | undefined = options.rawBody;
        if (body === undefined && options.body !== undefined) {
          body = JSON.stringify(options.body);
          headers['content-type'] ??= 'application/json';
        }

        const response = await withTimeout(
          fetchImpl(url, {
            method: options.method ?? 'GET',
            headers,
            body,
            signal: controller.signal,
          }),
          timeoutMs,
          this.provider,
          () => controller.abort(),
        );

        if (!response.ok && !accept.has(response.status)) {
          const detail = await this.safeReadText(response);
          throw new ProviderError({
            provider: this.provider,
            message: `HTTP ${response.status} ${response.statusText} for ${options.method ?? 'GET'} ${redactUrl(url)}`,
            retryable: isRetryableHttpStatus(response.status),
            status: response.status,
            details: { status: response.status, body: detail.slice(0, 500) },
          });
        }

        return {
          status: response.status,
          headers: response.headers,
          data: (await this.parseBody(response)) as T,
        };
      },
      { ...this.defaults.retry, ...options.retry, label: this.provider },
    );
  }

  private resolveUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const base = (this.defaults.baseUrl ?? '').replace(/\/+$/, '');
    return `${base}/${path.replace(/^\/+/, '')}`;
  }

  private async parseBody(response: Response): Promise<unknown> {
    if (response.status === 204) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json();
    }
    if (contentType.startsWith('text/')) {
      return response.text();
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async safeReadText(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch {
      return '<unreadable response body>';
    }
  }
}

/** Strips query strings from URLs before they reach a log line or an error message. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
