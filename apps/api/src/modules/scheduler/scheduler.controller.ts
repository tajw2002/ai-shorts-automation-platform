import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createScheduleSchema,
  updateScheduleSchema,
  type CreateScheduleDto,
  type SessionUser,
  type UpdateScheduleDto,
} from '@shorts/contracts';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { Roles } from '@/modules/auth/auth.guard';
import { CurrentUser } from '@/modules/auth/current-user.decorator';
import { AuditService } from '@/modules/system/audit.service';
import { SchedulerService } from './scheduler.service';

@ApiTags('schedules')
@Controller('schedules')
export class SchedulerController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.scheduler.list();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.scheduler.findById(id);
  }

  @Post()
  @Roles('ADMIN', 'EDITOR')
  async create(
    @Body(zodBody(createScheduleSchema)) dto: CreateScheduleDto,
    @CurrentUser() user: SessionUser,
  ) {
    const schedule = await this.scheduler.create(dto);
    await this.audit.record({
      userId: user.id,
      action: 'schedule.create',
      entityType: 'Schedule',
      entityId: schedule.id,
      metadata: { name: dto.name, timezone: dto.timezone },
    });
    return schedule;
  }

  @Patch(':id')
  @Roles('ADMIN', 'EDITOR')
  async update(
    @Param('id') id: string,
    @Body(zodBody(updateScheduleSchema)) dto: UpdateScheduleDto,
    @CurrentUser() user: SessionUser,
  ) {
    const schedule = await this.scheduler.update(id, dto);
    await this.audit.record({
      userId: user.id,
      action: 'schedule.update',
      entityType: 'Schedule',
      entityId: id,
    });
    return schedule;
  }

  @Post(':id/activate')
  @Roles('ADMIN', 'EDITOR')
  async activate(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    const schedule = await this.scheduler.setActive(id, true);
    await this.audit.record({
      userId: user.id,
      action: 'schedule.activate',
      entityType: 'Schedule',
      entityId: id,
    });
    return schedule;
  }

  @Post(':id/pause')
  @Roles('ADMIN', 'EDITOR')
  async pause(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    const schedule = await this.scheduler.setActive(id, false);
    await this.audit.record({
      userId: user.id,
      action: 'schedule.pause',
      entityType: 'Schedule',
      entityId: id,
    });
    return schedule;
  }

  @Delete(':id')
  @Roles('ADMIN')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.scheduler.remove(id);
    await this.audit.record({
      userId: user.id,
      action: 'schedule.delete',
      entityType: 'Schedule',
      entityId: id,
    });
    return { deleted: true };
  }

  /** Manual trigger, for testing a schedule without waiting for its slot. */
  @Post('run-now')
  @Roles('ADMIN')
  runNow() {
    return this.scheduler.tick();
  }
}
