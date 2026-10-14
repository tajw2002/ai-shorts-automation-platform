import { Injectable } from '@nestjs/common';
import { PUBLISHABLE_LICENSE_STATUSES, type PrivacyStatus, VideoStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { dayKey, startOfDayInZone, startOfMonthInZone } from '@/common/utils/time';

/**
 * The last line of defence before anything reaches YouTube.
 *
 * Every reason a publish could be wrong is checked in one place and returned as
 * a list, so an operator sees *all* the blockers at once rather than fixing them
 * one refused request at a time.
 *
 * The checks are ordered from cheapest to most expensive, and from most to least
 * severe: a kill switch is reported before a quota.
 */

export interface PublishDecision {
  allowed: boolean;
  /** Every reason publishing is currently refused. Empty when allowed. */
  blockers: string[];
  /** Non-blocking observations worth showing the operator. */
  warnings: string[];
  /** The privacy status that will actually be applied. */
  effectivePrivacyStatus: PrivacyStatus;
  /** True when DRY_RUN means no real upload will occur. */
  simulated: boolean;
  quota: { usedToday: number; dailyLimit: number; usedThisMonth: number; monthlyLimit: number };
}

@Injectable()
export class PublishGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly settings: SystemSettingsService,
  ) {}

  async evaluate(videoId: string): Promise<PublishDecision> {
    const blockers: string[] = [];
    const warnings: string[] = [];

    const [state, quotas, defaultPrivacy] = await Promise.all([
      this.settings.getOperationalState(),
      this.settings.getUploadQuotas(),
      this.settings.getDefaultPrivacyStatus(),
    ]);

    /* -- Kill switches ----------------------------------------------------- */

    if (state.emergencyStop) blockers.push('Emergency stop is active.');
    if (state.uploadsPaused) blockers.push('Uploads are paused by an operator.');

    /* -- The video itself -------------------------------------------------- */

    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        assets: { select: { licenseStatus: true, kind: true } },
        qualityReports: { orderBy: { createdAt: 'desc' }, take: 1 },
        channel: { select: { id: true, isActive: true, madeForKids: true } },
      },
    });

    if (!video) {
      return {
        allowed: false,
        blockers: ['The video no longer exists.'],
        warnings,
        effectivePrivacyStatus: defaultPrivacy,
        simulated: this.config.safety.dryRun,
        quota: {
          usedToday: 0,
          dailyLimit: quotas.daily,
          usedThisMonth: 0,
          monthlyLimit: quotas.monthly,
        },
      };
    }

    if (video.status !== VideoStatus.APPROVED && video.status !== VideoStatus.QUEUED) {
      blockers.push(`The video is ${video.status}; only an APPROVED video can be published.`);
    }

    if (state.requireApproval && !video.approvedAt) {
      blockers.push('Approval is required and this video has not been approved by a person.');
    }

    /* -- Quality and safety ------------------------------------------------ */

    const report = video.qualityReports[0];
    if (!report) {
      blockers.push('The video has not passed quality control.');
    } else if (!report.passed) {
      blockers.push(`Quality control failed with ${report.failureCount} error(s).`);
    } else if (report.warningCount > 0) {
      warnings.push(`Quality control passed with ${report.warningCount} warning(s).`);
    }

    if (video.safetyVerdict === 'BLOCK') {
      blockers.push('The content safety layer blocked this video.');
    } else if (video.safetyVerdict === 'REVIEW') {
      warnings.push('The safety layer flagged this video for review.');
    }

    /* -- Assets and licensing ---------------------------------------- */

    const finalAsset = video.assets.find((asset) => asset.kind === 'FINAL_VIDEO');
    if (!finalAsset) blockers.push('There is no rendered video file to upload.');

    const unlicensed = video.assets.filter(
      (asset) => !PUBLISHABLE_LICENSE_STATUSES.includes(asset.licenseStatus),
    );
    if (unlicensed.length > 0) {
      blockers.push(`${unlicensed.length} asset(s) have unestablished provenance.`);
    }

    /* -- Metadata ---------------------------------------------------------- */

    if (!video.title?.trim()) blockers.push('The video has no title.');
    if (!video.description?.trim()) blockers.push('The video has no description.');

    /* -- Channel ----------------------------------------------------------- */

    if (!video.channelId || !video.channel) {
      blockers.push('No YouTube channel is assigned to this video.');
    } else if (!video.channel.isActive) {
      blockers.push('The assigned channel is disconnected.');
    }

    /* -- Quotas ------------------------------------------------------ */

    const quota = await this.getQuotaUsage(quotas);
    if (quotas.daily > 0 && quota.usedToday >= quotas.daily) {
      blockers.push(
        `The daily upload limit of ${quotas.daily} has been reached (${quota.usedToday} today).`,
      );
    }
    if (quotas.monthly > 0 && quota.usedThisMonth >= quotas.monthly) {
      blockers.push(
        `The monthly upload limit of ${quotas.monthly} has been reached ` +
          `(${quota.usedThisMonth} this month).`,
      );
    }

    /* -- Privacy ----------------------------------------------------------- */

    // A public upload requires AUTO_PUBLISH explicitly. Without it the video goes
    // up privately, which is recoverable; the reverse is not.
    const requested = video.privacyStatus;
    const effectivePrivacyStatus: PrivacyStatus =
      requested === 'public' && !state.autoPublish ? 'private' : requested;

    if (requested === 'public' && !state.autoPublish) {
      warnings.push(
        'AUTO_PUBLISH is off, so this video will be uploaded as private rather than public.',
      );
    }

    if (this.config.safety.dryRun) {
      warnings.push('DRY_RUN is enabled: the upload will be simulated, not sent to YouTube.');
    }

    return {
      allowed: blockers.length === 0,
      blockers,
      warnings,
      effectivePrivacyStatus,
      simulated: this.config.safety.dryRun,
      quota,
    };
  }

  /**
   * Upload counts for the current local day and month.
   *
   * Counts completed `UploadJob` rows rather than published videos, because a
   * scheduled upload consumes quota at the moment it is sent, not when it goes
   * public.
   */
  async getQuotaUsage(quotas: { daily: number; monthly: number }): Promise<{
    usedToday: number;
    dailyLimit: number;
    usedThisMonth: number;
    monthlyLimit: number;
  }> {
    const now = new Date();
    const timezone = this.config.app.timezone;

    const [usedToday, usedThisMonth] = await Promise.all([
      this.prisma.uploadJob.count({
        where: {
          status: { in: ['COMPLETED', 'UPLOADING', 'PROCESSING'] },
          createdAt: { gte: startOfDayInZone(now, timezone) },
        },
      }),
      this.prisma.uploadJob.count({
        where: {
          status: { in: ['COMPLETED', 'UPLOADING', 'PROCESSING'] },
          createdAt: { gte: startOfMonthInZone(now, timezone) },
        },
      }),
    ]);

    return {
      usedToday,
      dailyLimit: quotas.daily,
      usedThisMonth,
      monthlyLimit: quotas.monthly,
    };
  }

  /** `YYYY-MM-DD` for the operator's timezone; used in dashboard labels. */
  today(): string {
    return dayKey(new Date(), this.config.app.timezone);
  }
}
