import { type ScenePlan, type ScriptSceneDraft } from '@shorts/contracts';
import { type CharacterBrief } from '@/providers/llm/llm-provider.interface';

/**
 * Renders a scene into the prompt that reaches the video provider.
 *
 * This is a pure function on purpose. Prompt construction is the single most
 * consequential piece of text in the pipeline — it decides whether a character
 * looks the same from one video to the next — so it must be inspectable and
 * testable without a database, a model, or a network.
 *
 * The layout is deliberate and stable: action first (what the model should
 * depict), then character descriptions verbatim from the library, then framing,
 * then style. Reordering it changes output across the whole channel, so it is
 * treated as a versioned decision rather than an implementation detail.
 */

export interface ScenePromptContext {
  scene: ScriptSceneDraft;
  /** Only the characters that appear in this scene. */
  characters: CharacterBrief[];
  /** Global look applied to every scene, keeping the channel visually coherent. */
  visualStyle: string;
  /** Traits to suppress, merged with each character's own negative prompt. */
  baseNegativePrompt: string;
  width: number;
  height: number;
}

/** Applied to every prompt: the platform only ever produces fictional characters. */
const UNIVERSAL_STYLE_SUFFIX =
  'stylised 3D animation, clearly fictional cartoon characters, soft lighting, ' +
  'family-friendly, no text overlays, no watermarks, no logos';

/** Suppresses the failure modes that most often break a family-friendly render. */
const UNIVERSAL_NEGATIVE =
  'photorealistic human child, real person likeness, text, watermark, logo, ' +
  'brand marks, distorted anatomy, extra limbs, frightening imagery, blood, weapons';

export function buildScenePrompt(context: ScenePromptContext): string {
  const parts: string[] = [];

  parts.push(context.scene.action.trim());

  // Character fragments are injected verbatim — this is the consistency mechanism.
  for (const character of context.characters) {
    const fragment = [
      `${character.name}: ${character.promptDescription}`,
      character.appearance,
      character.outfit ? `wearing ${character.outfit}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    parts.push(fragment);
  }

  if (context.scene.camera) parts.push(context.scene.camera);
  if (context.scene.mood) parts.push(context.scene.mood);

  const styles = [context.visualStyle, ...context.characters.map((c) => c.visualStyle)]
    .map((style) => style.trim())
    .filter(Boolean);
  parts.push(...dedupe(styles));

  parts.push(`vertical ${context.width}x${context.height} composition`);
  parts.push(UNIVERSAL_STYLE_SUFFIX);

  return dedupe(parts.map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean)).join(', ');
}

export function buildNegativePrompt(context: ScenePromptContext): string {
  const parts = [
    UNIVERSAL_NEGATIVE,
    context.baseNegativePrompt,
    ...context.characters.map(
      (c) => (c as { negativePrompt?: string | null }).negativePrompt ?? '',
    ),
  ]
    .map((part) => part.trim())
    .filter(Boolean);

  return dedupe(parts).join(', ');
}

/**
 * Derives the seed for a scene.
 *
 * Anchored on the first character's seed so the same figure renders consistently,
 * and offset by the scene index so successive scenes are not identical frames.
 */
export function buildSceneSeed(
  characters: Array<{ visualSeed?: number | null }>,
  sceneIndex: number,
): number | null {
  const base = characters.find(
    (c) => c.visualSeed !== null && c.visualSeed !== undefined,
  )?.visualSeed;
  if (base === null || base === undefined) return null;
  return (base + sceneIndex * 977) % 2_147_483_647;
}

/**
 * Turns script scenes into fully rendered scene plans, resolving each scene's
 * cast from the character library by name.
 */
export function buildScenePlans(input: {
  scenes: ScriptSceneDraft[];
  charactersByName: Map<
    string,
    CharacterBrief & { visualSeed?: number | null; negativePrompt?: string | null }
  >;
  visualStyle: string;
  baseNegativePrompt: string;
  width: number;
  height: number;
}): ScenePlan[] {
  return input.scenes.map((scene, index) => {
    const characters = scene.characterNames
      .map((name) => input.charactersByName.get(name.toLowerCase()))
      .filter((character): character is NonNullable<typeof character> => Boolean(character));

    const context: ScenePromptContext = {
      scene,
      characters,
      visualStyle: input.visualStyle,
      baseNegativePrompt: input.baseNegativePrompt,
      width: input.width,
      height: input.height,
    };

    return {
      index: scene.index ?? index,
      prompt: buildScenePrompt(context),
      negativePrompt: buildNegativePrompt(context) || null,
      durationSeconds: scene.durationSeconds,
      seed: buildSceneSeed(characters, index),
      voiceover: scene.voiceover,
      onScreenText: scene.onScreenText,
      characterIds: characters.map((character) => character.id),
    };
  });
}

/** Case-insensitive de-duplication that preserves the first spelling seen. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}
