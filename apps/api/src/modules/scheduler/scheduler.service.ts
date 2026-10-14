import { Injectable, Logger } from '@nestjs/common';
import {
  type ApprovalMode,
  type CreateScheduleDto,
  type UpdateScheduleDto,
  VideoStatus,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { IdeasService } from '@/modules/content/ideas.service';
import { VideosService } from '@/modules/videos/videos.service';
import { PublishingService } from '@/modules/youtube/publishing.service';
import { PublishGuardService } from '@/modules/youtube/publish-guard.service';
import { SystemSettingsService } from '@/modules/system/system-settings.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { ConflictError, describeError, NotFoundError } from '@/common/errors';
import { isValidTimezone, nextSlotOccurrence } from '@/common/utils/time';

/**
 * Publishing schedules.
 *
 * A schedule describes wall-clock slots in an operator's timezone ("09:00, 15:00,
 * 20:00 Europe/Berlin"). `tick()` runs periodically and, for each schedule whose
 * next slot has arrived, does the smallest useful amount of work:
 *
 *   1. Publish an already-approved video if one is waiting.
 *   2. Otherwise, start producing one so a video exists by the next slot.
 *
 * Producing on demand at the slot would mean publishing minutes-to-hours late,
 * since generation is not instant. Filling the pipeline ahead of time is what
 * makes a schedule actually hold.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly ideas: IdeasService,
    private readonly videos: VideosService,
    private readonly publishing: PublishingService,
    private readonly guard: PublishGuardService,
    private readonly settings: SystemSettingsService,
    private readonly systemLog: SystemLogService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* CRUD                                                                   */
  /* ---------------------------------------------------------------------- */

  async list() {
    return this.prisma.schedule.findMany({
      orderBy: { createdAt: 'asc' },
      include: { slots: { orderBy: [{ hour: 'asc' }, { minute: 'asc' }] }, channel: true },
    });
  }

  async findById(id: string) {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id },
      include: { slots: true, channel: true },
    });
    if (!schedule) throw new NotFoundError('Schedule', id);
    return schedule;
  }

  async create(dto: CreateScheduleDto) {
    if (!isValidTimezone(dto.timezone)) {
      throw new ConflictError(`'${dto.timezone}' is not a valid IANA timezone.`);
    }

    const schedule = await this.prisma.schedule.create({
      data: {
        name: dto.name,
        channelId: dto.channelId,
        timezone: dto.timezone,
        videosPerDay: dto.videosPerDay,
        approvalMode: dto.approvalMode,
        status: dto.isActive ? 'ACTIVE' : 'PAUSED',
        slots: { create: dto.slots },
      },
      include: { slots: true },
    });

    return this.refreshNextRun(schedule.id);
  }

  async update(id: string, dto: UpdateScheduleDto) {
    await this.findById(id);
    if (dto.timezone && !isValidTimezone(dto.timezone)) {
      throw new ConflictError(`'${dto.timezone}' is not a valid IANA timezone.`);
    }

    await this.prisma.schedule.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.channelId !== undefined ? { channelId: dto.channelId } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.videosPerDay !== undefined ? { videosPerDay: dto.videosPerDay } : {}),
        ...(dto.approvalMode !== undefined ? { approvalMode: dto.approvalMode } : {}),
        ...(dto.isActive !== undefined ? { status: dto.isActive ? 'ACTIVE' : 'PAUSED' } : {}),
        // Slots are replaced wholesale: a partial update would need identity for
        // each slot, and the UI edits them as a set anyway.
        ...(dto.slots ? { slots: { deleteMany: {}, create: dto.slots } } : {}),
      },
    });

    return this.refreshNextRun(id);
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.prisma.schedule.delete({ where: { id } });
  }

  async setActive(id: string, active: boolean) {
    await this.findById(id);
    await this.prisma.schedule.update({
      where: { id },
      data: { status: active ? 'ACTIVE' : 'PAUSED' },
    });
    return this.refreshNextRun(id);
  }

  /* ---------------------------------------------------------------------- */
  /* Execution                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Runs every due schedule.
   *
   * Safe to call more often than needed: `nextRunAt` gates the work, so an extra
   * tick is a no-op rather than a duplicate publish.
   */
  async tick(now: Date = new Date()): Promise<{ published: number; started: number }> {
    const state = await this.settings.getOperationalState();
    if (state.emergencyStop) {
      this.logger.warn('Scheduler tick skipped: emergency stop is active.');
      return { published: 0, started: 0 };
    }

    const due = await this.prisma.schedule.findMany({
      where: { status: 'ACTIVE', OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
      include: { slots: true },
    });

    let published = 0;
    let started = 0;

    for (const schedule of due) {
      try {
        const outcome = await this.runSchedule(schedule.id, now);
        published += outcome.published;
        started += outcome.started;
      } catch (error) {
        await this.systemLog.error(
          'SchedulerService',
          `Schedule "${schedule.name}" failed to run.`,
          error,
        );
      } finally {
        await this.refreshNextRun(schedule.id, now).catch(() => undefined);
      }
    }

    return { published, started };
  }

  private async runSchedule(
    scheduleId: string,
    now: Date,
  ): Promise<{ published: number; started: number }> {
    const schedule = await this.findById(scheduleId);

    // A schedule that has never run has no `nextRunAt`; treat the first tick as
    // "arm it", not "fire immediately", so enabling a schedule at 14:00 does not
    // instantly publish against a 09:00 slot.
    if (!schedule.nextRunAt) {
      return { published: 0, started: 0 };
    }

    await this.prisma.schedule.update({
      where: { id: scheduleId },
      data: { lastRunAt: now },
    });

    const state = await this.settings.getOperationalState();
    let published = 0;

    // 1. Publish something that is ready, if publishing is currently allowed.
    if (!state.uploadsPaused) {
      const candidate = await this.prisma.video.findFirst({
        where: {
          status: VideoStatus.APPROVED,
          channelId: schedule.channelId,
          scheduledAt: null,
        },
        orderBy: { approvedAt: 'asc' },
      });

      if (candidate) {
        const decision = await this.guard.evaluate(candidate.id);
        if (decision.allowed) {
          await this.publishing.schedule(candidate.id, { channelId: schedule.channelId });
          published = 1;
          await this.systemLog.info(
            'SchedulerService',
            `Schedule "${schedule.name}" queued video ${candidate.id} for publication.`,
            { videoId: candidate.id },
          );
        } else {
          await this.systemLog.warn(
            'SchedulerService',
            `Schedule "${schedule.name}" could not publish video ${candidate.id}.`,
            { videoId: candidate.id, blockers: decision.blockers },
          );
        }
      }
    }

    // 2. Keep the pipeline stocked for future slots.
    const started = state.generationPaused ? 0 : await this.topUpPipeline(schedule);

    return { published, started };
  }

  /**
   * Ensures enough videos are in flight to satisfy the coming day.
   *
   * The target is one day's output; anything already in the pipeline counts
   * towards it, so a backlog does not cause runaway generation.
   */
  private async topUpPipeline(schedule: {
    id: string;
    name: string;
    channelId: string;
    videosPerDay: number;
    approvalMode: ApprovalMode;
  }): Promise<number> {
    const inFlight = await this.prisma.video.count({
      where: {
        channelId: schedule.channelId,
        status: {
          in: [
            VideoStatus.CREATED,
            VideoStatus.SCRIPT_GENERATED,
            VideoStatus.SCENES_PLANNED,
            VideoStatus.GENERATING,
            VideoStatus.GENERATED,
            VideoStatus.ASSEMBLING,
            VideoStatus.QUALITY_CHECK,
            VideoStatus.READY_FOR_REVIEW,
            VideoStatus.APPROVED,
          ],
        },
      },
    });

    const deficit = Math.max(0, schedule.videosPerDay - inFlight);
    if (deficit === 0) return 0;

    // One per tick: generation is expensive, and spreading it out means a
    // misconfigured schedule cannot exhaust the daily budget in a single minute.
    const toStart = Math.min(1, deficit);
    let started = 0;

    for (let i = 0; i < toStart; i += 1) {
      try {
        const idea = await this.nextUnusedIdea();
        await this.videos.create({ ideaId: idea.id, channelId: schedule.channelId });
        started += 1;
      } catch (error) {
        await this.systemLog.warn(
          'SchedulerService',
          `Schedule "${schedule.name}" could not start a new video: ${describeError(error)}`,
        );
        break;
      }
    }

    return started;
  }

  /** Reuses a ready idea if one exists; otherwise generates a fresh one. */
  private async nextUnusedIdea(): Promise<{ id: string }> {
    const existing = await this.prisma.contentIdea.findFirst({
      where: { status: 'READY', safetyVerdict: { not: 'BLOCK' } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (existing) return existing;

    const [generated] = await this.ideas.generate({
      count: 1,
      usePerformanceInsights: true,
    });
    if (!generated) throw new ConflictError('No idea could be generated for the schedule.');
    return { id: generated.id };
  }

  /** Recomputes `nextRunAt` from the schedule's slots and timezone. */
  async refreshNextRun(scheduleId: string, from: Date = new Date()) {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id: scheduleId },
      include: { slots: true },
    });
    if (!schedule) throw new NotFoundError('Schedule', scheduleId);

    // Look one second ahead so the slot that just fired is not selected again.
    const nextRunAt =
      schedule.status === 'ACTIVE'
        ? nextSlotOccurrence(
            schedule.slots.map((slot) => ({
              dayOfWeek: slot.dayOfWeek,
              hour: slot.hour,
              minute: slot.minute,
            })),
            schedule.timezone,
            new Date(from.getTime() + 1000),
          )
        : null;

    return this.prisma.schedule.update({
      where: { id: scheduleId },
      data: { nextRunAt },
      include: { slots: true, channel: true },
    });
  }

  /** The timezone used when a schedule does not specify one. */
  get defaultTimezone(): string {
    return this.config.app.timezone;
  }
}
