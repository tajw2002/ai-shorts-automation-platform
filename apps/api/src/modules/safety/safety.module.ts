import { Module } from '@nestjs/common';
import { SafetyService } from './safety.service';

@Module({
  providers: [SafetyService],
  exports: [SafetyService],
})
export class SafetyModule {}
