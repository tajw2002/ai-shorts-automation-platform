import { Inject, Injectable } from '@nestjs/common';
import {
  type ContentIdeaDraft,
  type CostCategory,
  type ScriptDraft,
  type UpdateScriptDto,
  usdToMicros,
} from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { LLM_PROVIDER } from '@/providers/provider.tokens';
import { type LLMProvider } from '@/providers/llm/llm-provider.interface';
import { CharactersService } from '@/modules/characters/characters.service';
import { SafetyService } from '@/modules/safety/safety.service';
import { SimilarityService } from '@/modules/similarity/similarity.service';
import { MeteredExecutor } from '@/modules/cost/metered-executor.service';
import {
  DuplicateContentError,
  NotFoundError,
  SafetyBlockedError,
  ValidationError,
} from '@/common/errors';

/**
 * Script generation and editing.
 *
 * Same shape as idea generation — generate, vet, persist — with one extra
 * concern: the scene durations must sum to something the configured format
 * allows, so `fitDurations` rescales them rather than letting a 90-second script
 * reach a pipeline that only accepts 60.
 */
@Injectable()
export class ScriptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    private readonly characters: CharactersService,
    private readonly safety: SafetyService,
    private readonly similarity: SimilarityService,
    private readonly metered: MeteredExecutor,
  ) {}

  async generateForIdea(
    ideaId: string,
    idea: ContentIdeaDraft,
    videoId?: string,
  ): Promise<{ id: string; draft: ScriptDraft }> {
    const characters = await this.characters.getBriefsByName(idea.characterNames);
    const avoidNarrations = await this.similarity.recentTexts('SCRIPT_NARRATION', 25);
    const format = this.config.media.format;

    const targetDuration = clamp(
      idea.targetDurationSeconds,
      format.minDurationSeconds,
      format.maxDurationSeconds,
    );

    const result = await this.metered.run(
      {
        category: 'LLM' satisfies CostCategory,
        provider: this.llm.name,
        operation: 'generateScript',
        estimatedMicros: usdToMicros(0.05),
        fallbackUnits: 1,
        fallbackUnitLabel: 'scripts',
        videoId: videoId ?? null,
      },
      () =>
        this.llm.generateScript({
          idea,
          characters,
          language: this.config.content.language,
          targetDurationSeconds: targetDuration,
          minDurationSeconds: format.minDurationSeconds,
          maxDurationSeconds: format.maxDurationSeconds,
          minSceneSeconds: this.config.video.clipMinSeconds,
          avoidNarrations,
        }),
    );

    const draft = fitDurations(result.data, format.minDurationSeconds, format.maxDurationSeconds);

    const assessment = await this.safety.evaluateAll([
      { text: draft.narration, surface: 'SCRIPT' },
      ...draft.scenes.map((scene) => ({ text: scene.action, surface: 'SCRIPT' as const })),
    ]);

    if (assessment.verdict === 'BLOCK') {
      throw new SafetyBlockedError(
        'The generated script was blocked by the content safety layer.',
        { categories: [...new Set(assessment.findings.map((f) => f.category))] },
      );
    }

    const similarity = await this.similarity.check({ narration: draft.narration });
    if (!similarity.passed) {
      throw new DuplicateContentError('The generated script is too similar to an existing one.', {
        worstScore: similarity.worstScore,
        matches: similarity.matches.slice(0, 3),
      });
    }

    const script = await this.prisma.script.create({
      data: {
        ideaId,
        title: draft.title,
        hook: draft.hook,
        narration: draft.narration,
        callToAction: draft.callToAction,
        estimatedDurationSeconds: draft.estimatedDurationSeconds,
        scenes: draft.scenes as never,
        safetyVerdict: assessment.verdict,
        safetyFindings: assessment.findings.length > 0 ? (assessment.findings as never) : undefined,
        similarityScore: similarity.worstScore,
        generatedBy: this.llm.name,
      },
    });

    await this.similarity.store([
      { kind: 'SCRIPT_NARRATION', text: draft.narration, scriptId: script.id },
    ]);

    return { id: script.id, draft };
  }

  async findById(id: string) {
    const script = await this.prisma.script.findUnique({ where: { id } });
    if (!script) throw new NotFoundError('Script', id);
    return script;
  }

  async toDraft(id: string): Promise<ScriptDraft> {
    const script = await this.findById(id);
    return {
      title: script.title,
      hook: script.hook,
      narration: script.narration,
      callToAction: script.callToAction,
      estimatedDurationSeconds: script.estimatedDurationSeconds,
      scenes: script.scenes as ScriptDraft['scenes'],
    };
  }

  /**
   * Applies an operator's edit.
   *
   * Edited scripts are re-checked for safety — a human editing text is not a
   * reason to skip the gate — but *not* for similarity, since deliberately
   * refining an existing script is a legitimate action.
   */
  async update(id: string, dto: UpdateScriptDto) {
    const existing = await this.findById(id);
    const scenes = (dto.scenes ?? existing.scenes) as ScriptDraft['scenes'];
    const narration = dto.narration ?? existing.narration;

    if (scenes.length === 0) {
      throw new ValidationError('A script must have at least one scene.');
    }

    const assessment = await this.safety.evaluateAll([
      { text: narration, surface: 'SCRIPT' },
      ...scenes.map((scene) => ({ text: scene.action, surface: 'SCRIPT' as const })),
    ]);

    if (assessment.verdict === 'BLOCK') {
      throw new SafetyBlockedError('The edited script was blocked by the content safety layer.', {
        categories: [...new Set(assessment.findings.map((f) => f.category))],
      });
    }

    return this.prisma.script.update({
      where: { id },
      data: {
        title: dto.title ?? existing.title,
        hook: dto.hook ?? existing.hook,
        narration,
        callToAction: dto.callToAction ?? existing.callToAction,
        estimatedDurationSeconds:
          dto.estimatedDurationSeconds ??
          scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0),
        scenes: scenes as never,
        safetyVerdict: assessment.verdict,
        safetyFindings: assessment.findings.length > 0 ? (assessment.findings as never) : undefined,
        revision: { increment: 1 },
      },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers — exported for unit testing.                                  */
/* -------------------------------------------------------------------------- */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Rescales scene durations so the total lands inside the allowed window.
 *
 * A model asked for 30 seconds will routinely return scenes summing to 42. Since
 * every scene is generated independently and paid for by the second, scaling
 * proportionally is both cheaper and more faithful to the intended pacing than
 * truncating scenes off the end.
 */
export function fitDurations(
  draft: ScriptDraft,
  minSeconds: number,
  maxSeconds: number,
): ScriptDraft {
  const total = draft.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
  if (total === 0) return draft;
  if (total >= minSeconds && total <= maxSeconds) {
    return { ...draft, estimatedDurationSeconds: round1(total) };
  }

  const target = clamp(total, minSeconds, maxSeconds);
  const factor = target / total;

  // Each scene keeps a floor of 0.5s so nothing collapses to an unrenderable clip.
  const scenes = draft.scenes.map((scene) => ({
    ...scene,
    durationSeconds: Math.max(0.5, round1(scene.durationSeconds * factor)),
  }));

  return {
    ...draft,
    scenes,
    estimatedDurationSeconds: round1(scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
