import { Inject, Injectable } from '@nestjs/common';
import {
  type ComponentHealth,
  type HealthStatus,
  type ProviderDescriptor,
  type SystemHealthReport,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { FfmpegRunner } from '@/infrastructure/ffmpeg/ffmpeg.runner';
import {
  LLM_PROVIDER,
  QUEUE_PROVIDER,
  STORAGE_PROVIDER,
  VIDEO_PROVIDER,
  VOICE_PROVIDER,
  YOUTUBE_PROVIDER,
} from '@/providers/provider.tokens';
import { type BaseProvider } from '@/providers/provider.types';
import { describeError } from '@/common/errors';

/**
 * System health.
 *
 * Every component is probed independently and a failure in one never prevents the
 * others from being reported — a health page that goes blank because storage is
 * down is exactly the wrong behaviour.
 *
 * Overall status is the worst component status, with one deliberate exception:
 * a `DISABLED` component (a provider intentionally left unconfigured) does not
 * degrade the system.
 */

/** A slow probe must not hold the health endpoint open. */
const PROBE_TIMEOUT_MS = 5_000;

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly ffmpeg: FfmpegRunner,
    @Inject(LLM_PROVIDER) private readonly llm: BaseProvider,
    @Inject(VIDEO_PROVIDER) private readonly video: BaseProvider,
    @Inject(VOICE_PROVIDER) private readonly voice: BaseProvider,
    @Inject(STORAGE_PROVIDER) private readonly storage: BaseProvider,
    @Inject(YOUTUBE_PROVIDER) private readonly youtube: BaseProvider,
    @Inject(QUEUE_PROVIDER) private readonly queue: BaseProvider,
  ) {}

  /** Liveness: is the process up? Deliberately free of dependencies. */
  liveness(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  /**
   * Readiness: can this instance serve traffic?
   *
   * Only the database is a hard requirement. A degraded video provider means we
   * cannot generate, but we can still serve the dashboard — taking the instance
   * out of rotation for that would be worse than staying up.
   */
  async readiness(): Promise<{
    status: HealthStatus;
    checks: Array<{ name: string; status: HealthStatus; message: string }>;
  }> {
    const database = await this.probe('database', () => this.prisma.ping());
    return {
      status: database.status === 'OK' ? 'OK' : 'ERROR',
      checks: [{ name: database.name, status: database.status, message: database.message }],
    };
  }

  /** The full System Health page. */
  async getReport(): Promise<SystemHealthReport> {
    const components = await Promise.all([
      this.probe('Database', () => this.prisma.ping()),
      this.probeProvider('LLM provider', this.llm),
      this.probeProvider('Video provider', this.video),
      this.probeProvider('Voice provider', this.voice),
      this.probeProvider('Storage', this.storage),
      this.probeProvider('YouTube', this.youtube),
      this.probeProvider('Queue', this.queue),
      this.probeFfmpeg(),
    ]);

    return {
      status: worstStatus(components.map((component) => component.status)),
      components,
      version: this.config.app.version,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      checkedAt: new Date().toISOString(),
    };
  }

  /** What the Providers page shows: which adapter is wired for each port. */
  describeProviders(): ProviderDescriptor[] {
    const configured = this.config.providers.configured;
    const dryRun = this.config.safety.dryRun;

    return [
      this.describe('LLM', this.llm, configured.llm, dryRun),
      this.describe('VIDEO', this.video, configured.video, dryRun),
      this.describe('VOICE', this.voice, configured.voice, dryRun),
      this.describe('STORAGE', this.storage, configured.storage, false),
      this.describe('YOUTUBE', this.youtube, configured.youtube, dryRun),
      this.describe('QUEUE', this.queue, configured.queue, false),
    ];
  }

  private describe(
    kind: ProviderDescriptor['kind'],
    provider: BaseProvider,
    configuredName: string,
    dryRunApplies: boolean,
  ): ProviderDescriptor {
    return {
      kind,
      implementation: provider.name,
      configured: provider.isConfigured(),
      forcedMock: dryRunApplies && provider.name === 'mock' && configuredName !== 'mock',
      details: {
        ...provider.describe(),
        selected: configuredName,
        missing: provider.missingConfiguration().join(', ') || null,
      },
    };
  }

  private async probeProvider(name: string, provider: BaseProvider): Promise<ComponentHealth> {
    const startedAt = Date.now();
    try {
      const health = await withDeadline(provider.healthCheck(), PROBE_TIMEOUT_MS);
      return {
        name: `${name} (${provider.name})`,
        status: health.status,
        message: health.message,
        latencyMs: health.latencyMs ?? Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        name: `${name} (${provider.name})`,
        status: 'ERROR',
        message: describeError(error),
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private async probe(name: string, check: () => Promise<unknown>): Promise<ComponentHealth> {
    const startedAt = Date.now();
    try {
      await withDeadline(check(), PROBE_TIMEOUT_MS);
      return {
        name,
        status: 'OK',
        message: 'Reachable.',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        name,
        status: 'ERROR',
        message: describeError(error),
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  private async probeFfmpeg(): Promise<ComponentHealth> {
    const startedAt = Date.now();
    const availability = await this.ffmpeg.checkAvailability();
    return {
      name: 'FFmpeg',
      status: availability.available ? 'OK' : 'ERROR',
      message: availability.message,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  }
}

const SEVERITY: Record<HealthStatus, number> = { OK: 0, DISABLED: 0, WARNING: 1, ERROR: 2 };

export function worstStatus(statuses: HealthStatus[]): HealthStatus {
  return statuses.reduce<HealthStatus>(
    (worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    'OK',
  );
}

/** A probe that hangs must not hang the health endpoint with it. */
async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Health probe timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
