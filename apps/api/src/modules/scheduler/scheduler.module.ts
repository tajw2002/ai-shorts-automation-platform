import { Module } from '@nestjs/common';
import { ContentModule } from '@/modules/content/content.module';
import { VideosModule } from '@/modules/videos/videos.module';
import { YouTubeModule } from '@/modules/youtube/youtube.module';
import { SystemModule } from '@/modules/system/system.module';
import { SchedulerService } from './scheduler.service';
import { SchedulerController } from './scheduler.controller';

@Module({
  imports: [ContentModule, VideosModule, YouTubeModule, SystemModule],
  controllers: [SchedulerController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
