import { Module } from '@nestjs/common';
import { SystemSettingsService } from './system-settings.service';
import { SystemLogService } from './system-log.service';
import { AuditService } from './audit.service';
import { HealthService } from './health.service';
import { ProbesController, SystemController } from './system.controller';
import { JobsModule } from '@/modules/jobs/jobs.module';

/**
 * Operational primitives most other modules depend on.
 *
 * It imports only JobsModule (needed so the emergency stop can cancel queued
 * work) and nothing that imports SystemModule back — cost reporting lives in
 * CostModule's own controller precisely to avoid that cycle.
 */
@Module({
  imports: [JobsModule],
  controllers: [SystemController, ProbesController],
  providers: [SystemSettingsService, SystemLogService, AuditService, HealthService],
  exports: [SystemSettingsService, SystemLogService, AuditService, HealthService],
})
export class SystemModule {}
