import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  type ContentIdeaDraft,
  type PerformanceAnalysisResult,
  type SafetyAssessment,
  type ScriptDraft,
  type VideoMetadataDraft,
} from '@shorts/contracts';
import { okHealth, type ProviderHealth, type ProviderResult } from '../provider.types';
import {
  type AnalyzePerformanceInput,
  type GenerateIdeasInput,
  type GenerateMetadataInput,
  type GenerateScriptInput,
  type LLMProvider,
  type ModerationInput,
} from './llm-provider.interface';

/**
 * Deterministic stand-in for a real language model.
 *
 * Two properties matter here:
 *  1. **Deterministic** — the same input always yields the same output, so tests
 *     can assert on content rather than on shape alone.
 *  2. **Varied** — output is seeded from the input and from a rotating template
 *     bank, so the similarity checks actually get distinguishable candidates and
 *     the anti-repetition layer is genuinely exercised in a dry run.
 */
@Injectable()
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';

  isConfigured(): boolean {
    return true;
  }

  missingConfiguration(): string[] {
    return [];
  }

  async healthCheck(): Promise<ProviderHealth> {
    return okHealth('Mock LLM provider — no external calls are made.', 0);
  }

  describe(): Record<string, string | number | boolean | null> {
    return { model: 'mock-llm-v1', deterministic: true, cost: 0 };
  }

  async generateIdeas(input: GenerateIdeasInput): Promise<ProviderResult<ContentIdeaDraft[]>> {
    const avoid = new Set(input.avoidTitles.map((t) => t.toLowerCase()));
    const ideas: ContentIdeaDraft[] = [];

    for (let i = 0; ideas.length < input.count && i < input.count * 6; i += 1) {
      const seed = this.seedFrom(
        input.niche,
        input.guidance ?? '',
        String(input.diversityPressure),
        String(i),
        input.avoidTitles.length.toString(),
      );
      const candidate = this.buildIdea(input, seed, i);
      if (avoid.has(candidate.title.toLowerCase())) continue;
      avoid.add(candidate.title.toLowerCase());
      ideas.push(candidate);
    }

    return {
      data: ideas,
      usage: { units: 800, unitLabel: 'tokens', inputTokens: 500, outputTokens: 300 },
      model: 'mock-llm-v1',
    };
  }

  async generateScript(input: GenerateScriptInput): Promise<ProviderResult<ScriptDraft>> {
    const seed = this.seedFrom(input.idea.title, input.idea.premise);
    const sceneCount = Math.max(3, Math.min(6, input.idea.beats.length));
    const perScene = Math.max(2, Math.round((input.targetDurationSeconds / sceneCount) * 10) / 10);

    const cast = input.characters.length > 0 ? input.characters : [FALLBACK_CHARACTER];
    const scenes = Array.from({ length: sceneCount }, (_, index) => {
      const beat = input.idea.beats[index] ?? input.idea.beats[input.idea.beats.length - 1] ?? '';
      const character = cast[index % cast.length]!;
      return {
        index,
        action: `${character.name} ${pick(SCENE_ACTIONS, seed + index)}. ${beat}`.trim(),
        voiceover: this.narrationLine(input.idea, beat, index, seed),
        onScreenText: index === 0 ? truncateWords(input.idea.hook, 6) : null,
        durationSeconds: perScene,
        characterNames: [character.name],
        camera: pick(CAMERA_MOVES, seed + index * 3),
        mood: pick(MOODS, seed + index * 7),
      };
    });

    const narration = scenes
      .map((s) => s.voiceover)
      .filter(Boolean)
      .join(' ');

    return {
      data: {
        title: input.idea.title,
        hook: input.idea.hook,
        narration,
        scenes,
        callToAction: 'Follow for more tiny adventures.',
        estimatedDurationSeconds: Math.round(sceneCount * perScene * 10) / 10,
      },
      usage: { units: 1200, unitLabel: 'tokens', inputTokens: 700, outputTokens: 500 },
      model: 'mock-llm-v1',
    };
  }

  async generateMetadata(
    input: GenerateMetadataInput,
  ): Promise<ProviderResult<VideoMetadataDraft>> {
    const seed = this.seedFrom(input.script.title);
    const title = truncateWords(`${input.script.title} ${pick(TITLE_SUFFIXES, seed)}`, 12);
    const disclosure = input.requiredDisclosure ? `\n\n${input.requiredDisclosure}` : '';

    return {
      data: {
        title,
        description:
          `${input.idea.premise}\n\n${input.script.callToAction}` +
          `\n\n#Shorts #${pick(HASHTAG_POOL, seed)} #${pick(HASHTAG_POOL, seed + 3)}` +
          disclosure,
        hashtags: ['shorts', pick(HASHTAG_POOL, seed), pick(HASHTAG_POOL, seed + 3)],
        tags: ['shorts', 'animation', pick(HASHTAG_POOL, seed + 5)],
        callToAction: input.script.callToAction,
      },
      usage: { units: 300, unitLabel: 'tokens', inputTokens: 200, outputTokens: 100 },
      model: 'mock-llm-v1',
    };
  }

  async analyzePerformance(
    input: AnalyzePerformanceInput,
  ): Promise<ProviderResult<PerformanceAnalysisResult>> {
    const sorted = [...input.videos].sort((a, b) => b.performanceScore - a.performanceScore);
    const top = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3)));
    const averageDuration =
      top.reduce((sum, v) => sum + v.durationSeconds, 0) / Math.max(1, top.length);
    const commonHour = mode(top.map((v) => v.publishedAtHourLocal));

    return {
      data: {
        insights: [
          {
            dimension: 'duration',
            observation: `Top performers average ${averageDuration.toFixed(0)}s.`,
            recommendation: `Aim for ${Math.round(averageDuration)}s ± 5s on new ideas.`,
            confidence: top.length >= 5 ? 0.6 : 0.3,
            sampleVideoIds: top.map((v) => v.id),
          },
          {
            dimension: 'posting_hour',
            observation: `Most top performers were published around ${commonHour}:00 local time.`,
            recommendation: `Keep at least one daily slot near ${commonHour}:00.`,
            confidence: top.length >= 5 ? 0.5 : 0.25,
            sampleVideoIds: top.map((v) => v.id),
          },
        ],
        sampleSize: input.videos.length,
        analyzedAt: new Date().toISOString(),
        summary:
          'Mock analysis: structural patterns only. No successful video is reused or imitated.',
      },
      usage: { units: 900, unitLabel: 'tokens', inputTokens: 800, outputTokens: 100 },
      model: 'mock-llm-v1',
    };
  }

  async moderate(input: ModerationInput): Promise<ProviderResult<SafetyAssessment>> {
    // The mock always defers to the deterministic rule layer rather than
    // pretending to have an opinion.
    return {
      data: {
        verdict: 'ALLOW',
        findings: [],
        evaluators: ['mock-llm'],
        evaluatedAt: new Date().toISOString(),
      },
      usage: { units: Math.ceil(input.text.length / 4), unitLabel: 'tokens' },
      model: 'mock-llm-v1',
    };
  }

  // -- helpers --------------------------------------------------------------

  private seedFrom(...parts: string[]): number {
    const digest = createHash('sha256').update(parts.join('|')).digest();
    return digest.readUInt32BE(0);
  }

  private buildIdea(input: GenerateIdeasInput, seed: number, index: number): ContentIdeaDraft {
    const cast = input.characters.length > 0 ? input.characters : [FALLBACK_CHARACTER];
    const lead = cast[seed % cast.length]!;
    const companion = cast[(seed + 1) % cast.length]!;
    const setting = pick(SETTINGS, seed);
    const problem = pick(PROBLEMS, seed + 11);
    const resolution = pick(RESOLUTIONS, seed + 23);

    return {
      title: `${lead.name} and the ${capitalize(problem)} ${capitalize(setting)}`,
      premise:
        `${lead.name} discovers ${problem} in the ${setting}. ` +
        `With help from ${companion.name}, they ${resolution}.`,
      hook: `${lead.name} did NOT expect this in the ${setting}!`,
      beats: [
        `${lead.name} arrives at the ${setting} and notices ${problem}.`,
        `${companion.name} tries to help and makes it funnier.`,
        `Together they ${resolution}.`,
        `A warm closing beat with both characters.`,
      ],
      characterNames: [lead.name, companion.name].filter((name, i, arr) => arr.indexOf(name) === i),
      tone: pick(TONES, seed + index),
      targetDurationSeconds: input.targetDurationSeconds,
      noveltyRationale: `Combination ${index + 1}: ${setting} × ${problem} × ${resolution}.`,
    };
  }

  private narrationLine(idea: ContentIdeaDraft, beat: string, index: number, seed: number): string {
    if (index === 0) return idea.hook;
    return `${beat} ${pick(NARRATION_CONNECTORS, seed + index)}`.trim();
  }
}

const FALLBACK_CHARACTER = {
  id: 'fallback',
  name: 'Pip',
  species: 'creature',
  ageDescriptor: null,
  appearance: 'a small round creature with big eyes',
  outfit: null,
  personality: 'curious',
  visualStyle: 'soft 3d render',
  promptDescription: 'a small round creature with big eyes, soft 3d render',
} as const;

const SETTINGS = ['garden', 'kitchen', 'rainy porch', 'blanket fort', 'sunny window', 'toy shelf'];
const PROBLEMS = [
  'a missing sock',
  'a very loud hiccup',
  'an upside-down puddle',
  'a stubborn button',
  'a runaway balloon',
  'a squeaky floorboard',
];
const RESOLUTIONS = [
  'invent a silly solution',
  'turn it into a game',
  'ask for a hug and figure it out',
  'build something wobbly but wonderful',
  'share a snack and laugh about it',
];
const TONES = ['wholesome', 'gently funny', 'cosy', 'playful', 'heart-warming'];
const SCENE_ACTIONS = [
  'peeks around a corner',
  'tumbles softly onto a cushion',
  'holds up a tiny discovery',
  'giggles and looks at the camera',
  'tiptoes forward',
];
const CAMERA_MOVES = [
  'slow push-in, eye level',
  'gentle handheld, low angle',
  'static wide, centred',
  'soft dolly right',
];
const MOODS = ['warm morning light', 'golden hour', 'soft overcast', 'cosy lamplight'];
const NARRATION_CONNECTORS = ['And then...', 'But wait!', 'Of course,', 'Somehow,'];
const TITLE_SUFFIXES = ['🥹', 'Adorable!', 'Wholesome', 'Tiny Moment'];
const HASHTAG_POOL = ['cute', 'wholesome', 'animation', 'aistory', 'cozy', 'funny'];

function pick<T>(pool: readonly T[], seed: number): T {
  return pool[Math.abs(seed) % pool.length]!;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncateWords(value: string, maxWords: number): string {
  const words = value.split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? value : words.slice(0, maxWords).join(' ');
}

function mode(values: number[]): number {
  if (values.length === 0) return 9;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}
