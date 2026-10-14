import { type HealthStatus } from '@shorts/contracts';

/** Result of a provider's own liveness probe, surfaced on the System Health page. */
export interface ProviderHealth {
  status: HealthStatus;
  message: string;
  latencyMs: number | null;
}

/** Every adapter implements this so health checks and the UI are uniform. */
export interface BaseProvider {
  /** Stable adapter name, e.g. `mock`, `anthropic`, `gcs`. */
  readonly name: string;
  /** True when the adapter has everything it needs to make a real call. */
  isConfigured(): boolean;
  /** Missing configuration keys, for a precise error message. */
  missingConfiguration(): string[];
  healthCheck(): Promise<ProviderHealth>;
  /** Non-secret settings echoed to the Providers dashboard page. */
  describe(): Record<string, string | number | boolean | null>;
}

/** Usage a provider reports back, so the cost layer can price the call. */
export interface ProviderUsage {
  /** Free-form unit count: tokens, seconds of video, characters of speech. */
  units: number;
  unitLabel: string;
  /** Split reporting for token-billed providers. */
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported cost, when it gives one. */
  actualCostMicros?: number;
}

export interface ProviderResult<T> {
  data: T;
  usage: ProviderUsage;
  /** Concrete model used, for reproducibility and cost attribution. */
  model: string;
  /** Upstream request id, so a failure can be traced with the vendor. */
  correlationId?: string;
}

export const okHealth = (
  message = 'Reachable',
  latencyMs: number | null = null,
): ProviderHealth => ({
  status: 'OK',
  message,
  latencyMs,
});

export const errorHealth = (message: string): ProviderHealth => ({
  status: 'ERROR',
  message,
  latencyMs: null,
});
