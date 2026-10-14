import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { usdToMicros } from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { ProviderError, ProviderNotConfiguredError } from '@/common/errors';
import { ProviderHttpClient } from '@/common/resilience';
import { errorHealth, okHealth, type ProviderHealth } from '../provider.types';
import {
  type VideoDownload,
  type VideoGenerationHandle,
  type VideoGenerationRequest,
  type VideoGenerationState,
  type VideoGenerationStatus,
  type VideoProvider,
} from './video-provider.interface';

/**
 * Replicate adapter (verified against the Replicate HTTP API reference).
 *
 * Replicate exposes two creation routes: `/v1/predictions` with a pinned
 * `version` hash, and `/v1/models/{owner}/{name}/predictions` for official
 * models. `VIDEO_MODEL` selects between them by shape:
 *   - `owner/name`                 → official-model route
 *   - a 64-character version hash  → versioned route
 *
 * The adapter deliberately does *not* pass `Prefer: wait`. Generation takes
 * minutes, and long work does not belong inside an HTTP request. It returns a
 * handle and the pipeline polls.
 */

const REPLICATE_BASE_URL = 'https://api.replicate.com/v1';
const VERSION_HASH = /^[0-9a-f]{64}$/i;
const OFFICIAL_MODEL = /^[\w.-]+\/[\w.-]+$/;

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output: string | string[] | null;
  error: string | null;
  urls?: { get?: string; cancel?: string };
  metrics?: { predict_time?: number };
}

@Injectable()
export class ReplicateVideoProvider implements VideoProvider {
  readonly name = 'replicate';
  private readonly http: ProviderHttpClient;

  constructor(private readonly config: AppConfig) {
    this.http = new ProviderHttpClient(this.name, {
      baseUrl: config.video.baseUrl || REPLICATE_BASE_URL,
      headers: {
        authorization: `Bearer ${config.video.apiKey}`,
        accept: 'application/json',
      },
      timeoutMs: 60_000,
      retry: { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 15_000, jitter: true },
    });
  }

  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!this.config.video.apiKey) missing.push('VIDEO_PROVIDER_API_KEY');
    if (!this.config.video.model) missing.push('VIDEO_MODEL');
    return missing;
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return errorHealth(`Not configured. Missing: ${this.missingConfiguration().join(', ')}`);
    }
    const startedAt = Date.now();
    try {
      // `/account` is the cheapest authenticated endpoint Replicate exposes.
      await this.http.request('/account', { retry: { attempts: 1 } });
      return okHealth('Replicate reachable', Date.now() - startedAt);
    } catch (error) {
      return errorHealth(error instanceof Error ? error.message : 'Replicate unreachable');
    }
  }

  describe(): Record<string, string | number | boolean | null> {
    return {
      model: this.config.video.model || null,
      pollIntervalMs: this.config.video.pollIntervalMs,
      timeoutMs: this.config.video.timeoutMs,
      costPerSecond: this.config.video.costPerSecond,
    };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationHandle> {
    this.assertConfigured();

    const { path, body } = this.buildCreateRequest(request);
    const response = await this.http.request<ReplicatePrediction>(path, {
      method: 'POST',
      body,
    });

    if (!response.data?.id) {
      throw new ProviderError({
        provider: this.name,
        message: 'Prediction was created without an id.',
        retryable: true,
      });
    }

    return {
      providerJobId: response.data.id,
      provider: this.name,
      model: this.config.video.model,
      estimatedCostMicros: this.estimateCost(request.durationSeconds),
    };
  }

  async getGenerationStatus(providerJobId: string): Promise<VideoGenerationStatus> {
    this.assertConfigured();

    const response = await this.http.request<ReplicatePrediction>(
      `/predictions/${encodeURIComponent(providerJobId)}`,
    );
    const prediction = response.data;

    return {
      state: mapStatus(prediction.status),
      progress: prediction.status === 'succeeded' ? 1 : prediction.status === 'starting' ? 0 : 0.5,
      outputUrl: prediction.status === 'succeeded' ? firstOutputUrl(prediction.output) : null,
      error:
        prediction.status === 'failed'
          ? (prediction.error ?? 'Prediction failed without a reason.')
          : prediction.status === 'canceled'
            ? 'Prediction was cancelled.'
            : null,
      actualCostMicros:
        prediction.metrics?.predict_time !== undefined
          ? this.estimateCost(prediction.metrics.predict_time)
          : null,
    };
  }

  async downloadVideo(outputUrl: string): Promise<VideoDownload> {
    // Output URLs are pre-signed CDN links, so no auth header is sent — and must
    // not be, since that would leak the API token to a third-party host.
    const response = await fetch(outputUrl);
    if (!response.ok || !response.body) {
      throw new ProviderError({
        provider: this.name,
        message: `Failed to download rendered clip (HTTP ${response.status}).`,
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    const length = response.headers.get('content-length');
    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      contentType: response.headers.get('content-type') ?? 'video/mp4',
      sizeBytes: length ? Number(length) : null,
    };
  }

  async cancelGeneration(providerJobId: string): Promise<void> {
    this.assertConfigured();
    await this.http.request(`/predictions/${encodeURIComponent(providerJobId)}/cancel`, {
      method: 'POST',
      retry: { attempts: 1 },
    });
  }

  // -- internals ------------------------------------------------------------

  private assertConfigured(): void {
    const missing = this.missingConfiguration();
    if (missing.length > 0) {
      throw new ProviderNotConfiguredError('VIDEO', this.name, missing);
    }
  }

  /**
   * Model inputs are not standardised across Replicate models, so the common
   * keys are sent and unknown ones are ignored by the model. Anything model
   * specific belongs in the ProviderConfig settings, not hard-coded here.
   */
  private buildCreateRequest(request: VideoGenerationRequest): {
    path: string;
    body: Record<string, unknown>;
  } {
    const input: Record<string, unknown> = {
      prompt: request.prompt,
      aspect_ratio: toAspectRatio(request.width, request.height),
      duration: Math.round(request.durationSeconds),
      fps: request.fps,
    };
    if (request.negativePrompt) input.negative_prompt = request.negativePrompt;
    if (request.seed !== null) input.seed = request.seed;

    // Models disagree on what they accept (one takes fps 24 only, another has no
    // fps at all), and Replicate validates against the model's schema. Anything
    // model-specific therefore comes from configuration, not from this file.
    applyOverrides(input, this.config.video.inputOverrides);

    const model = this.config.video.model;
    if (OFFICIAL_MODEL.test(model) && !VERSION_HASH.test(model)) {
      return { path: `/models/${model}/predictions`, body: { input } };
    }
    return { path: '/predictions', body: { version: model, input } };
  }

  private estimateCost(seconds: number): number {
    return usdToMicros(seconds * this.config.video.costPerSecond);
  }
}

export function mapStatus(status: ReplicatePrediction['status']): VideoGenerationState {
  switch (status) {
    case 'starting':
      return 'queued';
    case 'processing':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'failed';
  }
}

/** Replicate models return either a single URL or an array of them. */
export function firstOutputUrl(output: string | string[] | null): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length > 0) return output[0] ?? null;
  return null;
}

/**
 * `1080x1920` -> `9:16`.
 *
 * Replicate video models take an aspect-ratio *label*, never pixel dimensions.
 * Sending `1080:1920` is rejected at validation, before any money is spent.
 */
export function toAspectRatio(width: number, height: number): string {
  const divisor = greatestCommonDivisor(Math.round(width), Math.round(height));
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? Math.max(a, 1) : greatestCommonDivisor(b, a % b);
}

/** Merges configured inputs over the defaults; a `null` value removes the key. */
export function applyOverrides(
  input: Record<string, unknown>,
  overrides: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete input[key];
    else input[key] = value;
  }
}
