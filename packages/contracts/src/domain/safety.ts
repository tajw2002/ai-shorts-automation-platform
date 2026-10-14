import { type SafetyCategory, type SafetyVerdict } from '../enums';

export interface SafetyFinding {
  category: SafetyCategory;
  /** 0 → 1. Rule matches use fixed weights; an LLM reviewer supplies its own. */
  confidence: number;
  /** What triggered the finding. Never contains raw secrets. */
  reason: string;
  /** The matched excerpt, truncated. Useful for the review UI. */
  excerpt?: string;
}

export interface SafetyAssessment {
  verdict: SafetyVerdict;
  findings: SafetyFinding[];
  /** Which layers ran, e.g. `['rules']` or `['rules', 'llm']`. */
  evaluators: string[];
  evaluatedAt: string;
}

/** Text surface being evaluated; some rules only apply to some surfaces. */
export const SafetySurface = Object.freeze({
  IDEA: 'IDEA',
  SCRIPT: 'SCRIPT',
  SCENE_PROMPT: 'SCENE_PROMPT',
  METADATA: 'METADATA',
});
export type SafetySurface = (typeof SafetySurface)[keyof typeof SafetySurface];
