import { Inject, Injectable } from '@nestjs/common';
import {
  type ContentIdeaDraft,
  type CostCategory,
  type ScriptDraft,
  type VideoMetadataDraft,
  usdToMicros,
} from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { LLM_PROVIDER } from '@/providers/provider.tokens';
import { type LLMProvider } from '@/providers/llm/llm-provider.interface';
import { SafetyService } from '@/modules/safety/safety.service';
import { SimilarityService } from '@/modules/similarity/similarity.service';
import { MeteredExecutor } from '@/modules/cost/metered-executor.service';
import { SafetyBlockedError } from '@/common/errors';
import { normalizeHashtag, uniqueBy } from '@/common/utils/text';

/**
 * Title, description, tags and hashtags.
 *
 * Everything the model returns is normalised and bounded here rather than
 * trusted: YouTube rejects an over-long title outright, and a duplicated or
 * malformed hashtag is the kind of small defect that makes a channel look
 * automated.
 */

/** YouTube's hard limits. */
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 5000;
const TAGS_MAX = 15;
const HASHTAGS_MAX = 6;
/** YouTube ignores more than three hashtags in a description. */
const HASHTAGS_IN_DESCRIPTION = 3;

/**
 * Appended to every description. Disclosing AI generation is both a YouTube
 * policy expectation and the honest thing to do.
 */
const AI_DISCLOSURE =
  'This short features original AI-generated characters and animation. ' +
  'All characters are fictional.';

@Injectable()
export class MetadataService {
  constructor(
    private readonly config: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LLMProvider,
    private readonly safety: SafetyService,
    private readonly similarity: SimilarityService,
    private readonly metered: MeteredExecutor,
  ) {}

  async generate(
    idea: ContentIdeaDraft,
    script: ScriptDraft,
    videoId?: string,
  ): Promise<VideoMetadataDraft> {
    const avoidTitles = await this.similarity.recentTexts('VIDEO_TITLE', 40);

    const result = await this.metered.run(
      {
        category: 'LLM' satisfies CostCategory,
        provider: this.llm.name,
        operation: 'generateMetadata',
        estimatedMicros: usdToMicros(0.01),
        fallbackUnits: 1,
        fallbackUnitLabel: 'metadata',
        videoId: videoId ?? null,
      },
      () =>
        this.llm.generateMetadata({
          script,
          idea,
          language: this.config.content.language,
          avoidTitles,
          requiredDisclosure: AI_DISCLOSURE,
        }),
    );

    const metadata = normalizeMetadata(result.data);

    const assessment = await this.safety.evaluateAll([
      { text: metadata.title, surface: 'METADATA' },
      { text: metadata.description, surface: 'METADATA' },
    ]);

    if (assessment.verdict === 'BLOCK') {
      throw new SafetyBlockedError('The generated metadata was blocked by the safety layer.', {
        categories: [...new Set(assessment.findings.map((f) => f.category))],
      });
    }

    return metadata;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure normalisation — exported for unit testing.                            */
/* -------------------------------------------------------------------------- */

export function normalizeMetadata(draft: VideoMetadataDraft): VideoMetadataDraft {
  const hashtags = uniqueBy(
    draft.hashtags.map(normalizeHashtag).filter((tag) => tag.length > 0),
    (tag) => tag,
  ).slice(0, HASHTAGS_MAX);

  // '#Shorts' is what makes YouTube treat the upload as a Short, so it is always
  // present and always first.
  if (!hashtags.includes('shorts')) hashtags.unshift('shorts');

  const tags = uniqueBy(
    draft.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    (tag) => tag.toLowerCase(),
  ).slice(0, TAGS_MAX);

  return {
    title: truncateTitle(draft.title),
    description: buildDescription(draft.description, hashtags),
    hashtags,
    tags,
    callToAction: draft.callToAction.trim(),
  };
}

/**
 * Trims to YouTube's 100-character limit on a word boundary.
 *
 * A hard slice mid-word reads as broken; losing a word reads as intentional.
 */
export function truncateTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= TITLE_MAX) return cleaned;

  const cut = cleaned.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > TITLE_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

function buildDescription(description: string, hashtags: string[]): string {
  const body = description.replace(/\s+$/g, '').trim();
  const tagLine = hashtags
    .slice(0, HASHTAGS_IN_DESCRIPTION)
    .map((tag) => `#${tag}`)
    .join(' ');

  // The model is asked to include the disclosure; appending it here as well
  // would duplicate it, so add it only when it is genuinely absent.
  const withDisclosure = body.includes(AI_DISCLOSURE) ? body : `${body}\n\n${AI_DISCLOSURE}`;
  const withTags = withDisclosure.includes(tagLine)
    ? withDisclosure
    : `${withDisclosure}\n\n${tagLine}`;

  return withTags.slice(0, DESCRIPTION_MAX);
}

export { AI_DISCLOSURE };
