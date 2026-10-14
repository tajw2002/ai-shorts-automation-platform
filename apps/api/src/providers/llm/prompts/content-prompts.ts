import { z } from 'zod';
import {
  contentIdeaDraftSchema,
  scriptDraftSchema,
  videoMetadataDraftSchema,
} from '@shorts/contracts';
import {
  type AnalyzePerformanceInput,
  type CharacterBrief,
  type GenerateIdeasInput,
  type GenerateMetadataInput,
  type GenerateScriptInput,
  type ModerationInput,
} from '../llm-provider.interface';

/**
 * Prompt text and response schemas shared by every real LLM adapter.
 *
 * This lives in the provider layer, not the domain layer: it is vendor-facing
 * text, and keeping one copy means switching from Anthropic to OpenAI does not
 * silently change what the model is asked to do.
 *
 * Two constraints are repeated in every prompt because they are the platform's
 * two hard content rules: produce original work, and keep any
 * child character unambiguously fictional and safe.
 */

const ORIGINALITY_RULE = `
ORIGINALITY (non-negotiable):
- Invent original stories. Never reproduce, adapt, paraphrase or "remix" an existing
  video, script, character or franchise from any creator or studio.
- Do not reference real people, real children, real brands, or copyrighted characters.
- If asked to avoid certain titles or premises, treat them as forbidden territory —
  produce something structurally and thematically different, not a rewording.`.trim();

const CHILD_SAFETY_RULE = `
SAFETY (non-negotiable):
- All characters are clearly fictional and clearly animated. Never describe a real,
  identifiable child.
- No sexualisation of any character, ever. No suggestive framing, clothing or posing.
- No danger, injury, distress, medical situations, weapons, or unsupervised risk.
- No content that would be unsettling to a young viewer.
- Keep everything wholesome, gentle and age-appropriate.`.trim();

function describeCharacters(characters: CharacterBrief[]): string {
  if (characters.length === 0) return 'No characters are defined yet; invent nothing recurring.';
  return characters
    .map(
      (c) =>
        `- ${c.name} (${c.species}${c.ageDescriptor ? `, ${c.ageDescriptor}` : ''}): ` +
        `${c.appearance}. Outfit: ${c.outfit ?? 'none specified'}. ` +
        `Personality: ${c.personality}. Visual style: ${c.visualStyle}.`,
    )
    .join('\n');
}

function bulletList(items: string[], emptyText: string, limit = 40): string {
  if (items.length === 0) return emptyText;
  return items
    .slice(0, limit)
    .map((item) => `- ${item}`)
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* Idea generation                                                            */
/* -------------------------------------------------------------------------- */

export const ideasResponseSchema = z.object({
  ideas: z.array(contentIdeaDraftSchema).min(1),
});

export function buildIdeasSystemPrompt(): string {
  return `You are a senior short-form video writer producing original vertical shorts.
${ORIGINALITY_RULE}

${CHILD_SAFETY_RULE}

Return ideas that differ from each other along at least two axes (setting, problem,
emotional beat, character pairing). Shallow variations of the same idea are rejected.`;
}

export function buildIdeasUserPrompt(input: GenerateIdeasInput): string {
  const pressure =
    input.diversityPressure > 0
      ? `\nThis is retry ${input.diversityPressure}. Previous attempts were rejected as too ` +
        `similar to existing content. Move decisively further away: change the setting ` +
        `category, the kind of problem, and the emotional shape of the ending.`
      : '';

  return `Niche: ${input.niche}
Language: ${input.language}
Target duration: ${input.targetDurationSeconds} seconds
Number of distinct ideas to produce: ${input.count}

Character library (use only these; do not invent new recurring characters):
${describeCharacters(input.characters)}

Titles that already exist — do NOT produce anything close to these:
${bulletList(input.avoidTitles, '(none yet)')}

Premises that already exist — do NOT produce anything close to these:
${bulletList(input.avoidPremises, '(none yet)')}

Patterns observed in past high performers (guidance for structure only — never copy a
specific video):
${bulletList(input.performanceGuidance, '(no analytics yet)')}
${input.guidance ? `\nAdditional direction from the operator: ${input.guidance}` : ''}${pressure}

For each idea supply: title, premise, hook, 3-5 beats, characterNames drawn from the
library, tone, targetDurationSeconds, and noveltyRationale explaining what makes it
different from everything listed above.`;
}

/* -------------------------------------------------------------------------- */
/* Script generation                                                          */
/* -------------------------------------------------------------------------- */

export const scriptResponseSchema = scriptDraftSchema;

export function buildScriptSystemPrompt(): string {
  return `You write tight, warm scripts for vertical short-form video.
${ORIGINALITY_RULE}

${CHILD_SAFETY_RULE}

Craft rules:
- The hook occupies the first 1-2 seconds and must create a question in the viewer's mind.
- Narration is spoken aloud: short sentences, concrete nouns, no stage directions in the
  voiceover text.
- Every scene must be visually renderable from its action description alone.
- The sum of scene durations must land inside the allowed range.`;
}

export function buildScriptUserPrompt(input: GenerateScriptInput): string {
  return `Write the script for this idea.

Title: ${input.idea.title}
Premise: ${input.idea.premise}
Hook: ${input.idea.hook}
Beats:
${bulletList(input.idea.beats, '(none)')}
Tone: ${input.idea.tone}
Language: ${input.language}

Duration: target ${input.targetDurationSeconds}s, allowed range ${input.minDurationSeconds}-${input.maxDurationSeconds}s.
${narrationBudgetRule(input.targetDurationSeconds, input.maxDurationSeconds)}

Characters available:
${describeCharacters(input.characters)}

Narration from earlier videos — do not reuse these phrasings or sentence patterns:
${bulletList(
  input.avoidNarrations.map((n) => n.slice(0, 160)),
  '(none yet)',
)}

${scenePacingRule(input.minSceneSeconds)}Produce 3-6 scenes. For each: index, action, voiceover, onScreenText (or null),
durationSeconds, characterNames, camera, mood. Also produce the full narration string
(the concatenated voiceover), a callToAction, and estimatedDurationSeconds.`;
}

/** Narration runs at roughly this pace; ElevenLabs voices measured close to it. */
const WORDS_PER_SECOND = 2.5;

/**
 * Turns the duration target into a word budget.
 *
 * Asked for 25 seconds, the model estimated 25 s but wrote 118 words — 47 s once
 * spoken. Models count words reliably and seconds of speech badly, and the
 * narration length now decides how much picture is ordered.
 */
export function narrationBudgetRule(targetSeconds: number, maxSeconds: number): string {
  const target = Math.round(targetSeconds * WORDS_PER_SECOND);
  const ceiling = Math.floor(maxSeconds * WORDS_PER_SECOND);
  return (
    `Length: the whole narration must be about ${target} words (it is spoken at about ` +
    `${WORDS_PER_SECOND} words per second) and never more than ${ceiling} words. ` +
    `Count the words before answering.`
  );
}

/**
 * Asks for scenes long enough to be worth their clip.
 *
 * Every scene becomes one generated clip, and video models have a minimum clip
 * length. A scene spoken in 2 s still pays for, say, 4 s of picture, and is cut
 * back to 2 s in the edit. Narration runs at roughly 2.5 words per second.
 */
export function scenePacingRule(minSceneSeconds: number | undefined): string {
  if (!minSceneSeconds || minSceneSeconds <= 0) return '';
  const words = Math.ceil(minSceneSeconds * WORDS_PER_SECOND);
  return (
    `Pacing: every scene's voiceover must take at least ${minSceneSeconds}s to say aloud ` +
    `(at least ${words} words). Prefer fewer, fuller scenes over many short ones.\n\n`
  );
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                   */
/* -------------------------------------------------------------------------- */

export const metadataResponseSchema = videoMetadataDraftSchema;

export function buildMetadataSystemPrompt(): string {
  return `You write YouTube Shorts metadata that is accurate and non-clickbait.
${ORIGINALITY_RULE}

Rules:
- The title must describe what actually happens. Never promise something the video
  does not deliver.
- Maximum 100 characters for the title.
- No ALL CAPS words, no more than one emoji, no engagement-bait ("like if...", "comment
  below or else").
- Hashtags without the leading '#', lowercase, no spaces.`;
}

export function buildMetadataUserPrompt(input: GenerateMetadataInput): string {
  return `Write metadata for this short.

Title from the script: ${input.script.title}
Hook: ${input.script.hook}
Premise: ${input.idea.premise}
Narration: ${input.script.narration.slice(0, 1500)}
Call to action: ${input.script.callToAction}
Language: ${input.language}

Existing channel titles — the new title must be clearly distinct:
${bulletList(input.avoidTitles, '(none yet)')}
${
  input.requiredDisclosure
    ? `\nAppend this disclosure verbatim at the end of the description:\n${input.requiredDisclosure}`
    : ''
}

Return: title, description, hashtags (max 6), tags (max 12), callToAction.`;
}

/* -------------------------------------------------------------------------- */
/* Performance analysis                                                       */
/* -------------------------------------------------------------------------- */

export const performanceResponseSchema = z.object({
  insights: z
    .array(
      z.object({
        dimension: z.string().max(60),
        observation: z.string().max(600),
        recommendation: z.string().max(600),
        confidence: z.number().min(0).max(1),
        sampleVideoIds: z.array(z.string()).default([]),
      }),
    )
    .max(10),
  summary: z.string().max(1200),
});

export function buildPerformanceSystemPrompt(): string {
  return `You are an analyst looking for structural patterns in short-form performance.

Hard rule: extract *transferable patterns* only — hook shape, pacing, duration band,
character pairing, posting time. Never recommend recreating, re-editing or imitating a
specific video, and never suggest copying another creator. If the sample is too small to
support a claim, say so and lower the confidence rather than inventing a pattern.`;
}

export function buildPerformanceUserPrompt(input: AnalyzePerformanceInput): string {
  const rows = input.videos
    .map(
      (v) =>
        `- id=${v.id} | score=${v.performanceScore.toFixed(1)} | views=${v.views} | ` +
        `likes=${v.likes} | comments=${v.comments} | ${v.durationSeconds}s | ` +
        `hour=${v.publishedAtHourLocal} | cast=${v.characterNames.join('+') || 'n/a'} | ` +
        `hook="${v.hook.slice(0, 90)}"`,
    )
    .join('\n');

  return `Analyse these ${input.videos.length} published videos and report patterns.

${rows}

Return up to 6 insights, each with dimension, observation, recommendation, confidence
(0-1) and sampleVideoIds. Also return a short overall summary.`;
}

/* -------------------------------------------------------------------------- */
/* Moderation                                                                 */
/* -------------------------------------------------------------------------- */

export const moderationResponseSchema = z.object({
  verdict: z.enum(['ALLOW', 'REVIEW', 'BLOCK']),
  findings: z
    .array(
      z.object({
        category: z.enum([
          'VIOLENCE',
          'SEXUAL',
          'SELF_HARM',
          'DANGEROUS_CHALLENGE',
          'HATE',
          'ILLEGAL_ACTIVITY',
          'MEDICAL_ADVICE',
          'CHILD_SAFETY',
          'COPYRIGHT_RISK',
          'REAL_PERSON',
          'PROFANITY',
        ]),
        confidence: z.number().min(0).max(1),
        reason: z.string().max(400),
      }),
    )
    .max(12),
});

export function buildModerationSystemPrompt(): string {
  return `You review generated content for a children-friendly short-form channel.

Return BLOCK for anything sexual, violent, hateful, illegal, self-harm related, medically
risky, or that sexualises or endangers a child character. Return REVIEW when you are
uncertain or when the content references a real person, brand or copyrighted work.
Return ALLOW only when the content is clearly safe and clearly original.

When in doubt, choose REVIEW. A false REVIEW costs a human a minute; a false ALLOW costs
the channel.`;
}

export function buildModerationUserPrompt(input: ModerationInput): string {
  return `Surface: ${input.surface}
Language: ${input.language}

Content:
"""
${input.text.slice(0, 8000)}
"""`;
}
