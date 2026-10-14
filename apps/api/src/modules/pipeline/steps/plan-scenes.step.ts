import { Injectable } from '@nestjs/common';
import { VideoStatus } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { ScriptsService } from '@/modules/content/scripts.service';
import { SafetyService } from '@/modules/safety/safety.service';
import { SimilarityService } from '@/modules/similarity/similarity.service';
import { buildScenePlans } from '@/modules/content/scene-prompt.builder';
import { SafetyBlockedError, ValidationError } from '@/common/errors';
import {
  type PipelineContext,
  type PipelineStep,
  type PipelineStepResult,
} from '../pipeline.types';

/**
 * SCRIPT_GENERATED → SCENES_PLANNED.
 *
 * Turns script scenes into rendered visual prompts with the character library
 * injected, then vets the prompts themselves. Vetting the *prompt* — not only the
 * narration — matters: the prompt is what a generative model acts on, and it is
 * where an unsafe or infringing instruction would actually take effect.
 */
@Injectable()
export class PlanScenesStep implements PipelineStep {
  readonly from = VideoStatus.SCRIPT_GENERATED;
  readonly name = 'plan-scenes';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly scripts: ScriptsService,
    private readonly safety: SafetyService,
    private readonly similarity: SimilarityService,
  ) {}

  async execute(context: PipelineContext): Promise<PipelineStepResult> {
    const video = await this.prisma.video.findUniqueOrThrow({
      where: { id: context.videoId },
      include: { scenes: { select: { id: true } } },
    });

    if (video.scenes.length > 0) {
      return { next: VideoStatus.SCENES_PLANNED, note: 'Scenes already planned; reused.' };
    }
    if (!video.scriptId) {
      throw new ValidationError('Cannot plan scenes before a script exists.');
    }

    const draft = await this.scripts.toDraft(video.scriptId);

    // Load the full character rows: the prompt builder needs the seed and
    // negative prompt, which the trimmed brief does not carry.
    const characterRows = await this.prisma.character.findMany({
      where: {
        name: {
          in: [...new Set(draft.scenes.flatMap((scene) => scene.characterNames))],
          mode: 'insensitive',
        },
      },
    });

    const charactersByName = new Map(
      characterRows.map((row) => [
        row.name.toLowerCase(),
        {
          id: row.id,
          name: row.name,
          species: row.species,
          ageDescriptor: row.ageDescriptor,
          appearance: row.appearance,
          outfit: row.outfit,
          personality: row.personality,
          visualStyle: row.visualStyle,
          promptDescription: row.promptDescription,
          negativePrompt: row.negativePrompt,
          visualSeed: row.visualSeed,
          promptRevision: row.promptRevision,
        },
      ]),
    );

    const plans = buildScenePlans({
      scenes: draft.scenes,
      charactersByName,
      visualStyle: characterRows[0]?.visualStyle ?? '',
      baseNegativePrompt: '',
      width: this.config.media.format.width,
      height: this.config.media.format.height,
    });

    const assessment = await this.safety.evaluateAll(
      plans.map((plan) => ({ text: plan.prompt, surface: 'SCENE_PROMPT' as const })),
    );
    if (assessment.verdict === 'BLOCK') {
      throw new SafetyBlockedError('A generated scene prompt was blocked by the safety layer.', {
        categories: [...new Set(assessment.findings.map((f) => f.category))],
      });
    }

    const similarity = await this.similarity.check({ prompts: plans.map((plan) => plan.prompt) });

    await this.prisma.$transaction(async (tx) => {
      for (const plan of plans) {
        const scene = await tx.videoScene.create({
          data: {
            videoId: video.id,
            index: plan.index,
            prompt: plan.prompt,
            negativePrompt: plan.negativePrompt,
            seed: plan.seed,
            action: draft.scenes[plan.index]?.action ?? '',
            voiceover: plan.voiceover,
            onScreenText: plan.onScreenText,
            camera: draft.scenes[plan.index]?.camera ?? '',
            mood: draft.scenes[plan.index]?.mood ?? '',
            durationSeconds: plan.durationSeconds,
          },
        });

        // Record which character revision produced this scene, so an old render
        // stays explainable after the library is edited.
        for (const characterId of plan.characterIds) {
          const character = characterRows.find((row) => row.id === characterId);
          await tx.sceneCharacter.create({
            data: {
              sceneId: scene.id,
              characterId,
              promptRevision: character?.promptRevision ?? 1,
            },
          });
        }
      }

      await tx.video.update({
        where: { id: video.id },
        data: {
          safetyVerdict: assessment.verdict,
          durationSeconds: plans.reduce((sum, plan) => sum + plan.durationSeconds, 0),
        },
      });
    });

    await this.similarity.store(
      plans.map((plan) => ({
        kind: 'SCENE_PROMPT' as const,
        text: plan.prompt,
        videoId: video.id,
      })),
    );

    return {
      next: VideoStatus.SCENES_PLANNED,
      note:
        `${plans.length} scene prompts rendered` +
        (similarity.worstScore > 0
          ? ` (max prompt similarity ${similarity.worstScore.toFixed(2)}).`
          : '.'),
    };
  }
}
