import { Module } from '@nestjs/common';
import { AssetsModule } from '@/modules/assets/assets.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { SystemModule } from '@/modules/system/system.module';
import { PipelineModule } from '@/modules/pipeline/pipeline.module';
import { ChannelsService } from './channels.service';
import { PublishGuardService } from './publish-guard.service';
import { PublishingService } from './publishing.service';
import { YouTubeController } from './youtube.controller';

@Module({
  imports: [AssetsModule, JobsModule, SystemModule, PipelineModule],
  controllers: [YouTubeController],
  providers: [ChannelsService, PublishGuardService, PublishingService],
  exports: [ChannelsService, PublishGuardService, PublishingService],
})
export class YouTubeModule {}
