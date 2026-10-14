import { Module } from '@nestjs/common';
import { PipelineModule } from '@/modules/pipeline/pipeline.module';
import { AssetsModule } from '@/modules/assets/assets.module';
import { AnalyticsModule } from '@/modules/analytics/analytics.module';
import { SystemModule } from '@/modules/system/system.module';
import { VideosService } from './videos.service';
import { VideosController } from './videos.controller';

@Module({
  imports: [PipelineModule, AssetsModule, AnalyticsModule, SystemModule],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosModule {}
