import { Global, Module } from '@nestjs/common';
import { FfmpegRunner } from './ffmpeg.runner';

/**
 * Infrastructure-level ffmpeg access. Global because both the media pipeline and
 * the mock video provider need it, and there is no reason to have two.
 */
@Global()
@Module({
  providers: [FfmpegRunner],
  exports: [FfmpegRunner],
})
export class FfmpegModule {}
