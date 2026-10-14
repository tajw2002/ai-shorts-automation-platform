import { z } from 'zod';

/**
 * Content-engine value objects.
 *
 * These describe what the LLM is asked to produce and what the pipeline consumes.
 * They are deliberately strict: an LLM response that does not parse is a failure,
 * not something to paper over with defaults.
 */

export const contentIdeaDraftSchema = z.object({
  /** Working title of the idea, not necessarily the final YouTube title. */
  title: z.string().min(3).max(120),
  /** One-paragraph pitch. */
  premise: z.string().min(10).max(1000),
  /** The first 1-2 seconds of the video, in words. */
  hook: z.string().min(3).max(240),
  /** Beginning → middle → end in three to six beats. */
  beats: z.array(z.string().min(3).max(300)).min(2).max(8),
  /** Names of characters from the library this idea uses. */
  characterNames: z.array(z.string().min(1).max(80)).max(6).default([]),
  /** Emotional register, e.g. "wholesome", "gently funny". */
  tone: z.string().max(120).default('wholesome'),
  /** Intended runtime in seconds; the pipeline enforces the configured bounds. */
  targetDurationSeconds: z.number().int().min(5).max(180),
  /** Why this idea is distinct from what has already been made. */
  noveltyRationale: z.string().max(600).default(''),
});
export type ContentIdeaDraft = z.infer<typeof contentIdeaDraftSchema>;

export const scriptSceneDraftSchema = z.object({
  index: z.number().int().nonnegative(),
  /** What happens, in plain language — the basis for the visual prompt. */
  action: z.string().min(3).max(800),
  /** Narration or dialogue spoken over this scene. May be empty for a beat of silence. */
  voiceover: z.string().max(600).default(''),
  /** Optional on-screen text (distinct from subtitles). */
  onScreenText: z.string().max(120).nullable().default(null),
  durationSeconds: z.number().min(0.5).max(30),
  /** Character names appearing in this scene. */
  characterNames: z.array(z.string().min(1).max(80)).max(6).default([]),
  /** Camera/framing direction, e.g. "slow push-in, eye level". */
  camera: z.string().max(200).default(''),
  mood: z.string().max(120).default(''),
});
export type ScriptSceneDraft = z.infer<typeof scriptSceneDraftSchema>;

export const scriptDraftSchema = z.object({
  title: z.string().min(3).max(120),
  hook: z.string().min(3).max(240),
  /** Full narration text, used for voice generation and for similarity checks. */
  narration: z.string().min(10).max(6000),
  scenes: z.array(scriptSceneDraftSchema).min(1).max(20),
  callToAction: z.string().max(240).default(''),
  estimatedDurationSeconds: z.number().min(1).max(300),
});
export type ScriptDraft = z.infer<typeof scriptDraftSchema>;

/** A scene after prompt rendering — what actually goes to the video provider. */
export const scenePlanSchema = z.object({
  index: z.number().int().nonnegative(),
  prompt: z.string().min(10).max(4000),
  negativePrompt: z.string().max(2000).nullable(),
  durationSeconds: z.number().min(0.5).max(30),
  seed: z.number().int().nonnegative().nullable(),
  voiceover: z.string().max(600),
  onScreenText: z.string().max(120).nullable(),
  characterIds: z.array(z.string()).default([]),
});
export type ScenePlan = z.infer<typeof scenePlanSchema>;

export const videoMetadataDraftSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().min(10).max(5000),
  /** Without the leading '#'. Normalised and de-duplicated by the service. */
  hashtags: z.array(z.string().min(1).max(40)).max(15).default([]),
  tags: z.array(z.string().min(1).max(60)).max(20).default([]),
  callToAction: z.string().max(240).default(''),
});
export type VideoMetadataDraft = z.infer<typeof videoMetadataDraftSchema>;

/**
 * Fingerprints used by the anti-repetition layer. Persisted alongside
 * every idea/script so future generations can be compared cheaply.
 */
export interface ContentFingerprint {
  /** SHA-256 of the normalised text. Detects exact duplicates. */
  contentHash: string;
  /** 64-bit SimHash as a decimal string — a cheap near-duplicate pre-filter. */
  simhash: string;
  /** Normalised text kept for the precise Jaccard/cosine comparison. */
  normalized: string;
}

export interface SimilarityMatch {
  /** Id of the existing record the candidate resembles. */
  recordId: string;
  /** 0 (unrelated) → 1 (identical). */
  score: number;
  field: 'title' | 'script' | 'prompt' | 'premise';
}

export interface SimilarityCheckResult {
  passed: boolean;
  /** Highest score observed across all compared fields. */
  worstScore: number;
  matches: SimilarityMatch[];
}
