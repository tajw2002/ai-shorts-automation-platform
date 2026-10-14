import { Module } from '@nestjs/common';
import { SubtitleService } from './subtitle.service';
import { AssemblyService } from './assembly.service';
import { QualityControlService } from './quality-control.service';

@Module({
  providers: [SubtitleService, AssemblyService, QualityControlService],
  exports: [SubtitleService, AssemblyService, QualityControlService],
})
export class MediaModule {}
