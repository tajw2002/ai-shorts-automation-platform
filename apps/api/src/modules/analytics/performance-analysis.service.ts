import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PerformanceAnalysisResult, usdToMicros } from '@shorts/contracts';
import { PrismaService } from '@/prisma/prisma.service';
import { AppConfig } from '@/config/app-config';
import { LLM_PROVIDER } from '@/providers/provider.tokens';
import { type LLMProvider } from '@/providers/llm/llm-provider.interface';
import { MeteredExecutor } from '@/modules/cost/metered-executor.service';
import { SystemLogService } from '@/modules/system/system-log.service';
import { getZonedParts } from '@/common/utils/time';

/**
 * AI performance analysis.
 *
 * Looks at what performed well and extracts *patterns* — hook shape, duration
 * band, character pairing, posting hour — which then steer future idea generation.
 *
 * The boundary that matters: insights describe structure, never content. Nothing
 * here feeds a specific successful video back in as a template, and the prompt
 * says so explicitly. Recycling a winner is how a channel ends up publishing five
 * versions of the same short.
 */

/** Below this there is not enough signal to distinguish a pattern from noise. */
const MIN_SAMPLE_SIZE = 5;

@Injectable()
export class PerformanceAnalysisService {
  private readonly logger = new Logger(PerformanceAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    private readonly metered: MeteredExecutor,
    private readonly systemLog: SystemLogService,
  ) {}

  async analyze(): Promise<PerformanceAnalysisResult | null> {
    const videos = await this.prisma.video.findMany({
      where: { status: 'PUBLISHED', publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
      take: 100,
      include: {
        script: { select: { hook: true } },
        scenes: {
          select: { characters: { select: { character: { select: { name: true } } } } },
        },
      },
    });

    if (videos.length < MIN_SAMPLE_SIZE) {
      this.logger.debug(
        `Only ${videos.length} published videos; need ${MIN_SAMPLE_SIZE} before analysing.`,
      );
      return null;
    }

    const timezone = this.config.app.timezone;
    const payload = videos.map((video) => ({
      id: video.id,
      title: video.title ?? '',
      hook: video.script?.hook ?? '',
      durationSeconds: video.durationSeconds ?? 0,
      characterNames: [
        ...new Set(
          video.scenes.flatMap((scene) => scene.characters.map((link) => link.character.name)),
        ),
      ],
      // Local hour, because "posts well at 9am" is a statement about the audience's
      // clock, not UTC.
      publishedAtHourLocal: video.publishedAt ? getZonedParts(video.publishedAt, timezone).hour : 0,
      views: video.views,
      likes: video.likes,
      comments: video.comments,
      performanceScore: video.performanceScore ?? 0,
    }));

    const result = await this.metered.run(
      {
        category: 'LLM',
        provider: this.llm.name,
        operation: 'analyzePerformance',
        estimatedMicros: usdToMicros(0.05),
        fallbackUnits: payload.length,
        fallbackUnitLabel: 'videos',
      },
      () =>
        this.llm.analyzePerformance({
          videos: payload,
          language: this.config.content.language,
        }),
    );

    await this.persist(result.data);
    await this.systemLog.info(
      'PerformanceAnalysisService',
      `Analysed ${payload.length} videos and stored ${result.data.insights.length} insights.`,
    );

    return result.data;
  }

  async getActiveInsights() {
    return this.prisma.performanceInsight.findMany({
      where: { isActive: true },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      take: 20,
    });
  }

  async getLatestGeneratedAt(): Promise<string | null> {
    const latest = await this.prisma.performanceInsight.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return latest?.createdAt.toISOString() ?? null;
  }

  /**
   * Replaces the active insight set.
   *
   * Superseding rather than accumulating: stale guidance from a much smaller
   * sample would otherwise keep steering generation forever.
   */
  private async persist(result: PerformanceAnalysisResult): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.performanceInsight.updateMany({
        where: { isActive: true },
        data: { isActive: false },
      }),
      this.prisma.performanceInsight.createMany({
        data: result.insights.map((insight) => ({
          dimension: insight.dimension,
          observation: insight.observation,
          recommendation: insight.recommendation,
          confidence: insight.confidence,
          sampleVideoIds: insight.sampleVideoIds,
          sampleSize: result.sampleSize,
          isActive: true,
          generatedBy: this.llm.name,
        })),
      }),
    ]);
  }
}
