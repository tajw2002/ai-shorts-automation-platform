import { Injectable } from '@nestjs/common';
import { VideoStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { IdeasService } from '@/modules/content/ideas.service';
import { ScriptsService } from '@/modules/content/scripts.service';
import { ValidationError } from '@/common/errors';
import {
  type PipelineContext,
  type PipelineStep,
  type PipelineStepResult,
} from '../pipeline.types';

/**
 * CREATED → SCRIPT_GENERATED.
 *
 * Idempotent because a video that already has a script simply advances: a retry
 * after a crash between "script written" and "status updated" must not pay for a
 * second script.
 */
@Injectable()
export class GenerateScriptStep implements PipelineStep {
  readonly from = VideoStatus.CREATED;
  readonly name = 'generate-script';

  constructor(
    private readonly prisma: PrismaService,
    private readonly ideas: IdeasService,
    private readonly scripts: ScriptsService,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: context.videoId },
      select: { id: true, ideaId: true, scriptId: true },
    });

    if (video.scriptId) {
      return { next: VideoStatus.SCRIPT_GENERATED, note: 'Script already present; reused.' };
    }

    if (!video.ideaId) {
      throw new ValidationError('A video cannot be produced without a content idea.');
    }

    const idea = await this.ideas.toDraft(video.ideaId);
    const { id: scriptId, draft } = await this.scripts.generateForIdea(
      video.ideaId,
      idea,
      video.id,
    );

    await this.prisma.$transaction([
      this.prisma.video.update({
        where: { id: video.id },
        data: { scriptId, title: draft.title },
      }),
      this.prisma.contentIdea.update({
        where: { id: video.ideaId },
        data: { status: 'IN_PRODUCTION' },
      }),
    ]);

    return {
      next: VideoStatus.SCRIPT_GENERATED,
      note: `Script with ${draft.scenes.length} scenes (~${draft.estimatedDurationSeconds}s).`,
    };
  }
}
