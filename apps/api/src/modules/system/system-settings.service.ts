import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  ApprovalMode,
  type OperationalState,
  type PrivacyStatus,
  SystemSettingKey,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';

/**
 * Runtime-mutable operational switches.
 *
 * Environment variables supply the boot defaults; a `SystemSetting` row, when
 * present, wins. This is what lets an operator hit the kill switch from the
 * dashboard without a redeploy, while a fresh deployment still starts from the
 * safe configuration in the environment.
 *
 * Values are cached in memory with a short TTL. Every guarded operation reads
 * them, so an uncached read per generation step would be wasteful — but the TTL
 * is small enough that an emergency stop takes effect within seconds, and
 * `set()` invalidates the cache immediately for the instance that made the change.
 */
const CACHE_TTL_MS = 5_000;

type SettingValue = string | number | boolean;

@Injectable()
export class SystemSettingsService implements OnModuleInit {
  private readonly logger = new Logger(SystemSettingsService.name);
  private cache = new Map<string, SettingValue>();
  private cacheExpiresAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    // Warm the cache so the first guarded call does not pay for a round trip,
    // and so a broken settings table is discovered at boot.
    await this.refresh().catch((error: unknown) => {
      this.logger.warn(`Could not preload system settings: ${String(error)}`);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                  */
  /* ---------------------------------------------------------------------- */

  async getBoolean(key: SystemSettingKey, fallback: boolean): Promise<boolean> {
    const value = await this.get(key);
    return typeof value === 'boolean' ? value : fallback;
  }

  async getNumber(key: SystemSettingKey, fallback: number): Promise<number> {
    const value = await this.get(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  async getString(key: SystemSettingKey, fallback: string): Promise<string> {
    const value = await this.get(key);
    return typeof value === 'string' ? value : fallback;
  }

  /** The full operational picture, as the dashboard and every guard need it. */
  async getOperationalState(): Promise<OperationalState> {
    const [emergencyStop, generationPaused, uploadsPaused, autoPublish, requireApproval] =
      await Promise.all([
        this.getBoolean(SystemSettingKey.EMERGENCY_STOP, this.config.safety.emergencyStop),
        this.getBoolean(SystemSettingKey.GENERATION_PAUSED, false),
        this.getBoolean(SystemSettingKey.UPLOADS_PAUSED, false),
        this.getBoolean(SystemSettingKey.AUTO_PUBLISH, this.config.safety.autoPublish),
        this.getBoolean(SystemSettingKey.REQUIRE_APPROVAL, this.config.safety.requireApproval),
      ]);

    return {
      emergencyStop,
      generationPaused,
      uploadsPaused,
      autoPublish,
      requireApproval,
      dryRun: this.config.safety.dryRun,
      haltReason: emergencyStop
        ? 'Emergency stop is active.'
        : generationPaused && uploadsPaused
          ? 'Generation and uploads are paused.'
          : generationPaused
            ? 'Generation is paused.'
            : uploadsPaused
              ? 'Uploads are paused.'
              : null,
    };
  }

  async getApprovalMode(): Promise<ApprovalMode> {
    const stored = await this.getString(SystemSettingKey.APPROVAL_MODE, '');
    return isApprovalMode(stored)
      ? stored
      : this.config.safety.requireApproval
        ? ApprovalMode.MANUAL
        : ApprovalMode.AUTO;
  }

  async getDefaultPrivacyStatus(): Promise<PrivacyStatus> {
    const stored = await this.getString(SystemSettingKey.DEFAULT_PRIVACY_STATUS, '');
    return stored === 'private' || stored === 'unlisted' || stored === 'public'
      ? stored
      : this.config.safety.defaultPrivacyStatus;
  }

  async getUploadQuotas(): Promise<{ daily: number; monthly: number }> {
    const [daily, monthly] = await Promise.all([
      this.getNumber(SystemSettingKey.MAX_DAILY_UPLOADS, this.config.quotas.maxDailyUploads),
      this.getNumber(SystemSettingKey.MAX_MONTHLY_UPLOADS, this.config.quotas.maxMonthlyUploads),
    ]);
    return { daily, monthly };
  }

  async getCostLimitsUsd(): Promise<{ daily: number; monthly: number }> {
    const [daily, monthly] = await Promise.all([
      this.getNumber(SystemSettingKey.MAX_DAILY_COST_USD, this.config.cost.maxDailyUsd),
      this.getNumber(SystemSettingKey.MAX_MONTHLY_COST_USD, this.config.cost.maxMonthlyUsd),
    ]);
    return { daily, monthly };
  }

  async areSubtitlesEnabled(): Promise<boolean> {
    return this.getBoolean(SystemSettingKey.SUBTITLES_ENABLED, this.config.media.subtitlesEnabled);
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                 */
  /* ---------------------------------------------------------------------- */

  async set(key: SystemSettingKey, value: SettingValue, updatedById?: string): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: value as never, updatedById: updatedById ?? null },
      update: { value: value as never, updatedById: updatedById ?? null },
    });
    this.cache.set(key, value);
    // Force other reads on this instance to see the change immediately.
    this.cacheExpiresAt = 0;
    this.logger.log(`System setting ${key} set to ${String(value)}`);
  }

  async setMany(
    entries: Partial<Record<SystemSettingKey, SettingValue>>,
    updatedById?: string,
  ): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) continue;
      await this.set(key as SystemSettingKey, value, updatedById);
    }
  }

  /** Convenience wrapper used by the emergency-stop endpoint. */
  async setEmergencyStop(enabled: boolean, updatedById?: string): Promise<void> {
    await this.set(SystemSettingKey.EMERGENCY_STOP, enabled, updatedById);
    if (enabled) {
      // Stopping means stopping: pausing both sides as well makes the state
      // unambiguous if someone later clears only the emergency flag.
      await this.set(SystemSettingKey.GENERATION_PAUSED, true, updatedById);
      await this.set(SystemSettingKey.UPLOADS_PAUSED, true, updatedById);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async get(key: string): Promise<SettingValue | undefined> {
    if (Date.now() >= this.cacheExpiresAt) await this.refresh();
    return this.cache.get(key);
  }

  private async refresh(): Promise<void> {
    const rows = await this.prisma.systemSetting.findMany();
    const next = new Map<string, SettingValue>();
    for (const row of rows) {
      const value = row.value;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        next.set(row.key, value);
      }
    }
    this.cache = next;
    this.cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  }
}

function isApprovalMode(value: string): value is ApprovalMode {
  return (
    value === ApprovalMode.MANUAL || value === ApprovalMode.SEMI_AUTO || value === ApprovalMode.AUTO
  );
}
