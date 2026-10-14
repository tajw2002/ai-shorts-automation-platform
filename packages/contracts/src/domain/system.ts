import { type HealthStatus, type ProviderKind } from '../enums';

export interface ComponentHealth {
  name: string;
  status: HealthStatus;
  message: string;
  /** Round-trip time of the probe. */
  latencyMs: number | null;
  checkedAt: string;
}

export interface SystemHealthReport {
  status: HealthStatus;
  components: ComponentHealth[];
  version: string;
  uptimeSeconds: number;
  checkedAt: string;
}

export interface ProviderDescriptor {
  kind: ProviderKind;
  /** The adapter actually wired in, e.g. `mock`, `anthropic`. */
  implementation: string;
  configured: boolean;
  /** True when DRY_RUN forced a mock in place of the configured adapter. */
  forcedMock: boolean;
  /** Non-secret configuration echoed back for the dashboard. */
  details: Record<string, string | number | boolean | null>;
}

/**
 * Runtime-mutable operational switches. These shadow the corresponding env vars:
 * env supplies the boot default, the database row (when present) wins at runtime
 * so an operator can flip a switch without a redeploy.
 */
export const SystemSettingKey = Object.freeze({
  EMERGENCY_STOP: 'EMERGENCY_STOP',
  GENERATION_PAUSED: 'GENERATION_PAUSED',
  UPLOADS_PAUSED: 'UPLOADS_PAUSED',
  AUTO_PUBLISH: 'AUTO_PUBLISH',
  REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
  APPROVAL_MODE: 'APPROVAL_MODE',
  MAX_DAILY_UPLOADS: 'MAX_DAILY_UPLOADS',
  MAX_MONTHLY_UPLOADS: 'MAX_MONTHLY_UPLOADS',
  MAX_DAILY_COST_USD: 'MAX_DAILY_COST_USD',
  MAX_MONTHLY_COST_USD: 'MAX_MONTHLY_COST_USD',
  DEFAULT_PRIVACY_STATUS: 'DEFAULT_PRIVACY_STATUS',
  SUBTITLES_ENABLED: 'SUBTITLES_ENABLED',
});
export type SystemSettingKey = (typeof SystemSettingKey)[keyof typeof SystemSettingKey];

export interface OperationalState {
  emergencyStop: boolean;
  generationPaused: boolean;
  uploadsPaused: boolean;
  autoPublish: boolean;
  requireApproval: boolean;
  dryRun: boolean;
  /** Why the system is halted, when it is. */
  haltReason: string | null;
}
