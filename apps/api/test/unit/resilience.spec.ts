import { computeBackoffDelay, pollUntil, withRetry, withTimeout } from '@/common/resilience/retry';
import {
  isRetryableHttpStatus,
  parseRetryAfter,
  ProviderHttpClient,
  redactUrl,
} from '@/common/resilience/http-client';
import { AppError, ProviderTimeoutError } from '@/common/errors';

/** Deterministic, instant "sleep" so the suite never actually waits. */
const noSleep = async (): Promise<void> => undefined;
const fixedRandom = () => 0.5;

describe('computeBackoffDelay', () => {
  it('grows exponentially without jitter', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 10_000, jitter: false };
    expect(computeBackoffDelay(1, opts)).toBe(100);
    expect(computeBackoffDelay(2, opts)).toBe(200);
    expect(computeBackoffDelay(3, opts)).toBe(400);
  });

  it('caps at maxDelayMs', () => {
    const opts = { baseDelayMs: 1_000, maxDelayMs: 3_000, jitter: false };
    expect(computeBackoffDelay(10, opts)).toBe(3_000);
  });

  it('applies full jitter within [0, cappedDelay]', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 10_000, jitter: true, random: fixedRandom };
    expect(computeBackoffDelay(3, opts)).toBe(200); // 0.5 * 400
  });
});

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const operation = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(operation, { sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and then succeeds', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('recovered');
    await expect(withRetry(operation, { sleep: noSleep, attempts: 3 })).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('stops after the configured number of attempts and rethrows the last error', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(operation, { sleep: noSleep, attempts: 3 })).rejects.toThrow(
      'always fails',
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error marked non-retryable', async () => {
    const fatal = new AppError({
      code: 'VALIDATION_FAILED',
      status: 400,
      message: 'bad input',
      retryable: false,
    });
    const operation = jest.fn().mockRejectedValue(fatal);
    await expect(withRetry(operation, { sleep: noSleep, attempts: 5 })).rejects.toBe(fatal);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries an error marked retryable', async () => {
    const transient = new AppError({
      code: 'PROVIDER_ERROR',
      status: 502,
      message: 'upstream hiccup',
      retryable: true,
    });
    const operation = jest.fn().mockRejectedValue(transient);
    await expect(withRetry(operation, { sleep: noSleep, attempts: 2 })).rejects.toBe(transient);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('reports the attempt number to the operation', async () => {
    const seen: number[] = [];
    await withRetry(
      async (attempt) => {
        seen.push(attempt);
        if (attempt < 3) throw new Error('again');
        return 'done';
      },
      { sleep: noSleep, attempts: 3 },
    );
    expect(seen).toEqual([1, 2, 3]);
  });

  it('invokes onRetry with the delay before each wait', async () => {
    const onRetry = jest.fn();
    await expect(
      withRetry(
        async () => {
          throw new Error('nope');
        },
        {
          sleep: noSleep,
          attempts: 3,
          jitter: false,
          baseDelayMs: 50,
          onRetry,
        },
      ),
    ).rejects.toThrow();
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[2]).toBe(50);
    expect(onRetry.mock.calls[1]?.[2]).toBe(100);
  });

  it('honours a total timeout budget instead of sleeping past it', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('slow'));
    await expect(
      withRetry(operation, {
        sleep: noSleep,
        attempts: 10,
        baseDelayMs: 10_000,
        jitter: false,
        totalTimeoutMs: 5_000,
      }),
    ).rejects.toThrow('slow');
    // The first backoff already exceeds the budget, so only one attempt runs.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rejects a nonsensical attempt count rather than looping', async () => {
    await expect(withRetry(async () => 'x', { attempts: 0 })).rejects.toThrow(RangeError);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('fast'), 1_000, 'test')).resolves.toBe('fast');
  });

  it('rejects with a typed timeout error', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 10, 'slow-provider')).rejects.toBeInstanceOf(
      ProviderTimeoutError,
    );
  });

  it('invokes onTimeout so the caller can abort the underlying work', async () => {
    const onTimeout = jest.fn();
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 10, 'p', onTimeout)).rejects.toThrow();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('propagates the original rejection unchanged', async () => {
    const failure = new Error('original');
    await expect(withTimeout(Promise.reject(failure), 1_000, 'p')).rejects.toBe(failure);
  });
});

describe('pollUntil', () => {
  it('returns the value once the check reports completion', async () => {
    let calls = 0;
    const result = await pollUntil(
      async () => {
        calls += 1;
        return calls < 3 ? { done: false } : { done: true, value: 'ready' };
      },
      { intervalMs: 1, timeoutMs: 1_000, label: 'job', sleep: noSleep },
    );
    expect(result).toBe('ready');
    expect(calls).toBe(3);
  });

  it('gives up at the deadline rather than polling forever', async () => {
    let now = 0;
    await expect(
      pollUntil(async () => ({ done: false }), {
        intervalMs: 100,
        timeoutMs: 500,
        label: 'stuck-job',
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('fails loudly when completion is signalled without a value', async () => {
    await expect(
      pollUntil(async () => ({ done: true }), {
        intervalMs: 1,
        timeoutMs: 100,
        label: 'job',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/without a value/);
  });
});

describe('isRetryableHttpStatus', () => {
  it('retries transient statuses only', () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(408)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('parses a delay in seconds', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000);
  });

  it('parses an HTTP date', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:45 GMT', now)).toBe(45_000);
  });

  it('never returns a negative delay for a past date', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2020 00:00:00 GMT', now)).toBe(0);
  });

  it('returns null for missing or unparseable values', () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
  });
});

describe('redactUrl', () => {
  it('drops the query string, which can carry tokens', () => {
    expect(redactUrl('https://api.example.com/v1/thing?api_key=secret')).toBe(
      'https://api.example.com/v1/thing',
    );
  });

  it('handles a non-URL string without throwing', () => {
    expect(redactUrl('not a url?with=query')).toBe('not a url');
  });
});

describe('ProviderHttpClient', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('sends JSON and parses a JSON response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new ProviderHttpClient('test', {
      baseUrl: 'https://api.example.com',
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.request<{ ok: boolean }>('/things', {
      method: 'POST',
      body: { name: 'x' },
    });

    expect(result.data.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/things');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"name":"x"}');
  });

  it('retries a 503 and succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'down' }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = new ProviderHttpClient('test', {
      timeoutMs: 1_000,
      retry: { attempts: 2, sleep: noSleep, baseDelayMs: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.request('https://api.example.com/x')).resolves.toMatchObject({
      status: 200,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: 'bad' }, 400));
    const client = new ProviderHttpClient('test', {
      timeoutMs: 1_000,
      retry: { attempts: 3, sleep: noSleep, baseDelayMs: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.request('https://api.example.com/x')).rejects.toThrow(/HTTP 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicitly allowed non-2xx status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response(null, { status: 308 }));
    const client = new ProviderHttpClient('test', {
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.request('https://api.example.com/x', { acceptStatuses: [308] }),
    ).resolves.toMatchObject({ status: 308 });
  });

  it('keeps the API token out of the error message', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 500));
    const client = new ProviderHttpClient('test', {
      headers: { authorization: 'Bearer super-secret-token' },
      timeoutMs: 1_000,
      retry: { attempts: 1 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.request('https://api.example.com/x?api_key=super-secret-token'),
    ).rejects.toThrow(/^(?!.*super-secret-token).*$/s);
  });
});
