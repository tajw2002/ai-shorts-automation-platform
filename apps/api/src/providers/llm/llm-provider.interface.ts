import {
  type ContentIdeaDraft,
  type PerformanceAnalysisResult,
  type SafetyAssessment,
  type ScriptDraft,
  type VideoMetadataDraft,
} from '@shorts/contracts';
import { type BaseProvider, type ProviderResult } from '../provider.types';

/**
 * The text-generation port.
 *
 * The methods are domain-shaped rather than a bare `complete(prompt)` so each
 * adapter can use whatever its vendor does best — structured outputs, tool use,
 * JSON mode — while the content engine only ever sees validated domain objects.
 */

/** A character as the prompt needs to see it. Trimmed of everything else. */
export interface CharacterBrief {
  id: string;
  name: string;
  species: string;
  ageDescriptor: string | null;
  appearance: string;
  outfit: string | null;
  personality: string;
  visualStyle: string;
  promptDescription: string;
}

export interface GenerateIdeasInput {
  niche: string;
  language: string;
  /** How many distinct candidates to produce in one call. */
  count: number;
  characters: CharacterBrief[];
  /**
   * Titles/premises already in the library. Supplied as negative context so the
   * model avoids them, *in addition to* the deterministic similarity check that
   * runs afterwards — the model is asked to help, but is never trusted to police
   * repetition on its own.
   */
  avoidTitles: string[];
  avoidPremises: string[];
  /** Patterns learned from analytics. Guidance only, never a template to copy. */
  performanceGuidance: string[];
  guidance?: string;
  targetDurationSeconds: number;
  /** Raised on a retry to push the model further away from what exists. */
  diversityPressure: number;
}

export interface GenerateScriptInput {
  idea: ContentIdeaDraft;
  characters: CharacterBrief[];
  language: string;
  targetDurationSeconds: number;
  /** Hard bounds from the media configuration. */
  minDurationSeconds: number;
  maxDurationSeconds: number;
  /**
   * Shortest clip the video model will produce, in seconds (0 = no limit). A scene
   * spoken in less time still pays for this much picture, so the script should not
   * contain such scenes.
   */
  minSceneSeconds?: number;
  /** Narration scripts already used, so wording is not recycled. */
  avoidNarrations: string[];
}

export interface GenerateMetadataInput {
  script: ScriptDraft;
  idea: ContentIdeaDraft;
  language: string;
  /** Existing titles, to keep the channel from looking auto-generated. */
  avoidTitles: string[];
  /** Appended verbatim; never invented by the model. */
  requiredDisclosure?: string;
}

export interface AnalyzePerformanceInput {
  videos: Array<{
    id: string;
    title: string;
    hook: string;
    durationSeconds: number;
    characterNames: string[];
    publishedAtHourLocal: number;
    views: number;
    likes: number;
    comments: number;
    performanceScore: number;
  }>;
  /** Instruction reinforced in the prompt: extract patterns, never copy a video. */
  language: string;
}

export interface ModerationInput {
  text: string;
  surface: string;
  language: string;
}

export interface LLMProvider extends BaseProvider {
  generateIdeas(input: GenerateIdeasInput): Promise<ProviderResult<ContentIdeaDraft[]>>;
  generateScript(input: GenerateScriptInput): Promise<ProviderResult<ScriptDraft>>;
  generateMetadata(input: GenerateMetadataInput): Promise<ProviderResult<VideoMetadataDraft>>;
  analyzePerformance(
    input: AnalyzePerformanceInput,
  ): Promise<ProviderResult<PerformanceAnalysisResult>>;
  /**
   * Optional second opinion for the safety layer. Adapters that cannot do this
   * should throw `ProviderNotConfiguredError`; the safety service treats a
   * failure here as "uncertain" and falls back to manual review.
   */
  moderate(input: ModerationInput): Promise<ProviderResult<SafetyAssessment>>;
}
