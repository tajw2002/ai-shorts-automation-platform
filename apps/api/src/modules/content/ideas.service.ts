import { Inject, Injectable } from '@nestjs/common';
import {
  type ContentIdeaDraft,
  type CostCategory,
  type GenerateIdeasDto,
  type IdeaStatus,
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
import { SystemLogService } from '@/modules/system/system-log.service';
import { DuplicateContentError, NotFoundError, SafetyBlockedError } from '@/common/errors';
import { truncate } from '@/common/utils/text';

/**
 * The idea half of the content engine.
 *
 * The generation loop is the important part:
 *
 *   ask for K candidates (with existing titles as negative context)
 *     → deterministic safety check
 *       → deterministic similarity check
 *         → first survivor wins
 *   nothing survived? raise the diversity pressure and ask again, up to N times.
 *
 * The model is asked to avoid repetition *and* the result is verified. Only the
 * verification is load-bearing: a model that ignores the instruction produces
 * candidates that get rejected, not duplicates that get published.
 */
@Injectable()
export class IdeasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    private readonly characters: CharactersService,
    private readonly safety: SafetyService,
    private readonly similarity: SimilarityService,
    private readonly metered: MeteredExecutor,
    private readonly systemLog: SystemLogService,
  ) {}

  /**
   * Generates and persists `dto.count` original ideas.
   *
   * Returns the ideas that survived every gate. If none did after the configured
   * number of attempts, it throws rather than persisting something mediocre —
   * a silent "close enough" is how a channel ends up looking auto-generated.
   */
  async generate(dto: GenerateIdeasDto): Promise<Array<{ id: string; title: string }>> {
    const characters = await this.characters.getBriefs(dto.characterIds);
    const [avoidTitles, avoidPremises, performanceGuidance] = await Promise.all([
      this.similarity.recentTexts('IDEA_TITLE', 60),
      this.similarity.recentTexts('IDEA_PREMISE', 40),
      dto.usePerformanceInsights ? this.activeInsightGuidance() : Promise.resolve([]),
    ]);

    const accepted: Array<{ id: string; title: string }> = [];
    const rejections: string[] = [];

    for (
      let attempt = 0;
      attempt < this.config.content.maxAttempts && accepted.length < dto.count;
      attempt += 1
    ) {
      const candidates = await this.requestCandidates({
        dto,
        characters,
        avoidTitles: [...avoidTitles, ...accepted.map((a) => a.title)],
        avoidPremises,
        performanceGuidance,
        diversityPressure: attempt,
      });

      for (const candidate of candidates) {
        if (accepted.length >= dto.count) break;

        const outcome = await this.vet(candidate);
        if (!outcome.ok) {
          rejections.push(`"${truncate(candidate.title, 60)}": ${outcome.reason}`);
          continue;
        }

        const stored = await this.persist(candidate, outcome.similarityScore);
        accepted.push({ id: stored.id, title: stored.title });
        // Keep subsequent candidates in this same batch from colliding with it.
        avoidTitles.push(candidate.title);
      }
    }

    if (accepted.length === 0) {
      await this.systemLog.warn(
        'IdeasService',
        `No idea survived vetting after ${this.config.content.maxAttempts} attempts.`,
        { rejections: rejections.slice(0, 10) },
      );
      throw new DuplicateContentError(
        'Every generated idea was rejected as unsafe or too similar to existing content. ' +
          'Try adding characters, adjusting the guidance, or relaxing the similarity thresholds.',
        { rejections: rejections.slice(0, 10) },
      );
    }

    if (accepted.length < dto.count) {
      await this.systemLog.warn(
        'IdeasService',
        `Requested ${dto.count} ideas but only ${accepted.length} passed vetting.`,
        { rejections: rejections.slice(0, 10) },
      );
    }

    return accepted;
  }

  /* ---------------------------------------------------------------------- */
  /* CRUD                                                                   */
  /* ---------------------------------------------------------------------- */

  async findById(id: string) {
    const idea = await this.prisma.contentIdea.findUnique({
      where: { id },
      include: { characters: { include: { character: true } } },
    });
    if (!idea) throw new NotFoundError('Idea', id);
    return idea;
  }

  async setStatus(id: string, status: IdeaStatus) {
    await this.findById(id);
    return this.prisma.contentIdea.update({ where: { id }, data: { status } });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.prisma.contentIdea.delete({ where: { id } });
  }

  /** Turns a stored idea back into the draft shape the pipeline consumes. */
  async toDraft(id: string): Promise<ContentIdeaDraft> {
    const idea = await this.findById(id);
    return {
      title: idea.title,
      premise: idea.premise,
      hook: idea.hook,
      beats: idea.beats,
      characterNames: idea.characters.map((link) => link.character.name),
      tone: idea.tone,
      targetDurationSeconds: idea.targetDurationSeconds,
      noveltyRationale: idea.noveltyRationale,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async requestCandidates(input: {
    dto: GenerateIdeasDto;
    characters: Awaited<ReturnType<CharactersService['getBriefs']>>;
    avoidTitles: string[];
    avoidPremises: string[];
    performanceGuidance: string[];
    diversityPressure: number;
  }): Promise<ContentIdeaDraft[]> {
    // Ask for more than we need: candidates are cheap relative to a wasted round
    // trip, and the vetting gates reject a meaningful fraction.
    const count = Math.max(
      input.dto.count,
      Math.min(this.config.content.candidatesPerRequest, input.dto.count * 3),
    );

    const result = await this.metered.run(
      {
        category: 'LLM' satisfies CostCategory,
        provider: this.llm.name,
        operation: 'generateIdeas',
        // Rough pre-call estimate; the recorded actual comes from reported usage.
        estimatedMicros: usdToMicros(0.02 * count),
        fallbackUnits: count,
        fallbackUnitLabel: 'ideas',
      },
      () =>
        this.llm.generateIdeas({
          niche: input.dto.niche ?? this.config.content.niche,
          language: this.config.content.language,
          count,
          characters: input.characters,
          avoidTitles: input.avoidTitles,
          avoidPremises: input.avoidPremises,
          performanceGuidance: input.performanceGuidance,
          guidance: input.dto.guidance,
          targetDurationSeconds: Math.round(
            (this.config.media.format.minDurationSeconds +
              this.config.media.format.maxDurationSeconds) /
              2,
          ),
          diversityPressure: input.diversityPressure,
        }),
    );

    return result.data;
  }

  /** Runs both gates and explains precisely why a candidate failed. */
  private async vet(
    candidate: ContentIdeaDraft,
  ): Promise<{ ok: true; similarityScore: number } | { ok: false; reason: string }> {
    const assessment = await this.safety.evaluateAll([
      { text: candidate.title, surface: 'IDEA' },
      { text: candidate.premise, surface: 'IDEA' },
      { text: candidate.beats.join(' '), surface: 'IDEA' },
    ]);

    if (assessment.verdict === 'BLOCK') {
      return {
        ok: false,
        reason: `safety BLOCK (${assessment.findings.map((f) => f.category).join(', ')})`,
      };
    }

    const similarity = await this.similarity.check({
      title: candidate.title,
      premise: candidate.premise,
    });

    if (!similarity.passed) {
      const worst = similarity.matches[0];
      return {
        ok: false,
        reason: `too similar to an existing idea (${worst?.field} score ${worst?.score.toFixed(2)})`,
      };
    }

    return { ok: true, similarityScore: similarity.worstScore };
  }

  private async persist(candidate: ContentIdeaDraft, similarityScore: number) {
    const characters = await this.characters.getBriefsByName(candidate.characterNames);
    const assessment = await this.safety.evaluateAll([
      { text: candidate.title, surface: 'IDEA' },
      { text: candidate.premise, surface: 'IDEA' },
    ]);

    // A REVIEW verdict is stored, not swallowed: it surfaces in the dashboard and
    // blocks auto-publish later in the pipeline.
    const idea = await this.prisma.contentIdea.create({
      data: {
        title: candidate.title,
        premise: candidate.premise,
        hook: candidate.hook,
        beats: candidate.beats,
        tone: candidate.tone,
        targetDurationSeconds: candidate.targetDurationSeconds,
        noveltyRationale: candidate.noveltyRationale,
        niche: this.config.content.niche,
        language: this.config.content.language,
        status: assessment.verdict === 'REVIEW' ? 'DRAFT' : 'READY',
        safetyVerdict: assessment.verdict,
        safetyFindings: assessment.findings.length > 0 ? (assessment.findings as never) : undefined,
        similarityScore,
        generatedBy: this.llm.name,
        characters: {
          create: characters.map((character) => ({ characterId: character.id })),
        },
      },
    });

    await this.similarity.store([
      { kind: 'IDEA_TITLE', text: candidate.title, ideaId: idea.id },
      { kind: 'IDEA_PREMISE', text: candidate.premise, ideaId: idea.id },
    ]);

    return idea;
  }

  /** Active insights, phrased as guidance the prompt can consume. */
  private async activeInsightGuidance(): Promise<string[]> {
    const insights = await this.prisma.performanceInsight.findMany({
      where: { isActive: true },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      take: 8,
    });
    return insights.map(
      (insight) => `${insight.dimension}: ${insight.observation} → ${insight.recommendation}`,
    );
  }
}

/** Raised when an idea is blocked outright, for callers that want to distinguish it. */
export { SafetyBlockedError };
