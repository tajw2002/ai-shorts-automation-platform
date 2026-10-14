import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createVideoSchema,
  listVideosSchema,
  regenerateVideoSchema,
  reviewVideoSchema,
  updateVideoMetadataSchema,
  type CreateVideoDto,
  type ListVideosDto,
  type RegenerateVideoDto,
  type ReviewVideoDto,
  type SessionUser,
  type UpdateVideoMetadataDto,
} from '@shorts/contracts';
import { zodBody, zodQuery } from '@/common/pipes/zod-validation.pipe';
import { Roles } from '@/modules/auth/auth.guard';
import { CurrentUser } from '@/modules/auth/current-user.decorator';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videos: VideosService) {}

  @Get()
  list(@Query(zodQuery(listVideosSchema)) query: ListVideosDto) {
    return this.videos.list(query);
  }

  /** The review queue: everything waiting on a human decision. */
  @Get('review-queue')
  reviewQueue() {
    return this.videos.listAwaitingReview();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.videos.findDetail(id);
  }

  @Post()
  @Roles('ADMIN', 'EDITOR')
  create(@Body(zodBody(createVideoSchema)) dto: CreateVideoDto, @CurrentUser() user: SessionUser) {
    return this.videos.create(dto, user.id);
  }

  @Post(':id/review')
  @Roles('ADMIN', 'EDITOR')
  review(
    @Param('id') id: string,
    @Body(zodBody(reviewVideoSchema)) dto: ReviewVideoDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.videos.review(id, dto.decision, dto.note, user.id);
  }

  @Post(':id/regenerate')
  @Roles('ADMIN', 'EDITOR')
  async regenerate(
    @Param('id') id: string,
    @Body(zodBody(regenerateVideoSchema)) dto: RegenerateVideoDto,
    @CurrentUser() user: SessionUser,
  ) {
    await this.videos.regenerate(id, dto, user.id);
    return { ok: true };
  }

  @Patch(':id/metadata')
  @Roles('ADMIN', 'EDITOR')
  updateMetadata(
    @Param('id') id: string,
    @Body(zodBody(updateVideoMetadataSchema)) dto: UpdateVideoMetadataDto,
    @CurrentUser() user: SessionUser,
  ) {
    return this.videos.updateMetadata(id, dto, user.id);
  }

  @Post(':id/cancel')
  @Roles('ADMIN', 'EDITOR')
  async cancel(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.videos.cancel(id, user.id);
    return { ok: true };
  }

  @Delete(':id')
  @Roles('ADMIN')
  async remove(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    await this.videos.remove(id, user.id);
    return { deleted: true };
  }
}
