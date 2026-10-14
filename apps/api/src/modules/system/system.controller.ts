import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  emergencyStopSchema,
  listLogsSchema,
  SystemSettingKey,
  updateSettingsSchema,
  type EmergencyStopDto,
  type ListLogsDto,
  type SessionUser,
  type UpdateSettingsDto,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { zodBody, zodQuery } from '@/common/pipes/zod-validation.pipe';
import { Public, Roles } from '@/modules/auth/auth.guard';
import { CurrentUser } from '@/modules/auth/current-user.decorator';
import { JobsService } from '@/modules/jobs/jobs.service';
import { SystemSettingsService } from './system-settings.service';
import { SystemLogService } from './system-log.service';
import { AuditService } from './audit.service';
import { HealthService } from './health.service';

/**
 * Operational control surface.
 *
 * The emergency stop lives here and is intentionally blunt: enabling it pauses
 * generation and uploads *and* cancels everything already queued, so a single
 * click actually stops the system rather than merely stopping new work.
 */
@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly settings: SystemSettingsService,
    private readonly systemLog: SystemLogService,
    private readonly audit: AuditService,
    private readonly health: HealthService,
    private readonly jobs: JobsService,
  ) {}

  @Get('health')
  getHealth() {
    return this.health.getReport();
  }

  @Get('providers')
  getProviders() {
    return { providers: this.health.describeProviders(), dryRun: this.config.safety.dryRun };
  }

  @Get('settings')
  async getSettings() {
    const [operational, quotas, limits, approvalMode, privacy, subtitles] = await Promise.all([
      this.settings.getOperationalState(),
      this.settings.getUploadQuotas(),
      this.settings.getCostLimitsUsd(),
      this.settings.getApprovalMode(),
      this.settings.getDefaultPrivacyStatus(),
      this.settings.areSubtitlesEnabled(),
    ]);

    return {
      ...operational,
      approvalMode,
      maxDailyUploads: quotas.daily,
      maxMonthlyUploads: quotas.monthly,
      maxDailyCostUsd: limits.daily,
      maxMonthlyCostUsd: limits.monthly,
      defaultPrivacyStatus: privacy,
      subtitlesEnabled: subtitles,
      // Environment-level facts the operator cannot change at runtime.
      readOnly: {
        dryRun: this.config.safety.dryRun,
        timezone: this.config.app.timezone,
        niche: this.config.content.niche,
        version: this.config.app.version,
      },
    };
  }

  @Post('settings')
  @Roles('ADMIN')
  async updateSettings(
    @Body(zodBody(updateSettingsSchema)) dto: UpdateSettingsDto,
    @CurrentUser() user: SessionUser,
  ) {
    await this.settings.setMany(
      {
        [SystemSettingKey.EMERGENCY_STOP]: dto.emergencyStop,
        [SystemSettingKey.GENERATION_PAUSED]: dto.generationPaused,
        [SystemSettingKey.UPLOADS_PAUSED]: dto.uploadsPaused,
        [SystemSettingKey.AUTO_PUBLISH]: dto.autoPublish,
        [SystemSettingKey.REQUIRE_APPROVAL]: dto.requireApproval,
        [SystemSettingKey.APPROVAL_MODE]: dto.approvalMode,
        [SystemSettingKey.MAX_DAILY_UPLOADS]: dto.maxDailyUploads,
        [SystemSettingKey.MAX_MONTHLY_UPLOADS]: dto.maxMonthlyUploads,
        [SystemSettingKey.MAX_DAILY_COST_USD]: dto.maxDailyCostUsd,
        [SystemSettingKey.MAX_MONTHLY_COST_USD]: dto.maxMonthlyCostUsd,
        [SystemSettingKey.DEFAULT_PRIVACY_STATUS]: dto.defaultPrivacyStatus,
        [SystemSettingKey.SUBTITLES_ENABLED]: dto.subtitlesEnabled,
      },
      user.id,
    );

    await this.audit.record({
      userId: user.id,
      action: 'settings.update',
      entityType: 'SystemSetting',
      metadata: dto as Record<string, unknown>,
    });

    return this.getSettings();
  }

  /**
   * The kill switch.
   *
   * Enabling it also cancels queued work. Disabling it only lifts the flags —
   * cancelled jobs are not resurrected, because an operator who stopped the system
   * should decide deliberately what to restart.
   */
  @Post('emergency-stop')
  @Roles('ADMIN')
  async emergencyStop(
    @Body(zodBody(emergencyStopSchema)) dto: EmergencyStopDto,
    @CurrentUser() user: SessionUser,
  ) {
    await this.settings.setEmergencyStop(dto.enabled, user.id);

    let cancelledJobs = 0;
    if (dto.enabled) {
      cancelledJobs = await this.jobs.cancelAllPending(
        dto.reason ?? 'Emergency stop activated by an operator.',
      );
    } else {
      await this.settings.setMany(
        {
          [SystemSettingKey.GENERATION_PAUSED]: false,
          [SystemSettingKey.UPLOADS_PAUSED]: false,
        },
        user.id,
      );
    }

    await this.audit.record({
      userId: user.id,
      action: dto.enabled ? 'system.emergency_stop' : 'system.emergency_resume',
      entityType: 'System',
      metadata: { reason: dto.reason ?? null, cancelledJobs },
    });

    await this.systemLog.warn(
      'SystemController',
      dto.enabled
        ? `Emergency stop activated${dto.reason ? `: ${dto.reason}` : ''}. ${cancelledJobs} job(s) cancelled.`
        : 'Emergency stop lifted; generation and uploads resumed.',
    );

    return { ...(await this.settings.getOperationalState()), cancelledJobs };
  }

  @Get('logs')
  async listLogs(@Query(zodQuery(listLogsSchema)) query: ListLogsDto) {
    const where = {
      ...(query.level ? { level: query.level } : {}),
      ...(query.service ? { service: query.service } : {}),
      ...(query.videoId ? { videoId: query.videoId } : {}),
      ...(query.jobId ? { jobId: query.jobId } : {}),
      ...(query.since ? { createdAt: { gte: new Date(query.since) } } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.systemLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.systemLog.count({ where }),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  @Get('audit')
  @Roles('ADMIN')
  async listAudit(@Query(zodQuery(listLogsSchema)) query: ListLogsDto) {
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { user: { select: { email: true, name: true } } },
      }),
      this.prisma.auditLog.count(),
    ]);

    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }
}

/**
 * Kubernetes/Cloud Run probes.
 *
 * Separate controller so these sit outside the `/api/v1` prefix and outside the
 * session guard — a probe must not need credentials, and must not be rate limited.
 */
@ApiTags('health')
@Controller()
export class ProbesController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get('liveness')
  liveness() {
    return this.health.liveness();
  }

  @Public()
  @Get('readiness')
  readiness() {
    return this.health.readiness();
  }
}
