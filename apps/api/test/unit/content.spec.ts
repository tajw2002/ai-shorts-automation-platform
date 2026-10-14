import {
  buildScenePlans,
  buildScenePrompt,
  buildSceneSeed,
} from '@/modules/content/scene-prompt.builder';
import { clamp, fitDurations } from '@/modules/content/scripts.service';
import {
  normalizeMetadata,
  truncateTitle,
  AI_DISCLOSURE,
} from '@/modules/content/metadata.service';
import { seedFromName } from '@/modules/characters/characters.service';
import { estimateSpeechDuration } from '@/providers/voice/mock-voice.provider';
import { colourFromPrompt } from '@/providers/video/mock-video.provider';
import { firstOutputUrl, mapStatus } from '@/providers/video/replicate-video.provider';
import { parseRangeHeader } from '@/providers/youtube/google-youtube.provider';
import { sanitizeTaskId } from '@/providers/queue/cloudtasks-queue.provider';
import type { ScriptDraft, ScriptSceneDraft } from '@shorts/contracts';

const LEO = {
  id: 'char-leo',
  name: 'Baby Leo',
  species: 'human (illustrated)',
  ageDescriptor: 'toddler',
  appearance: 'a stylised cartoon toddler with brown curls',
  outfit: 'mustard dungarees',
  personality: 'curious',
  visualStyle: 'soft stylised 3D animation',
  promptDescription: 'Baby Leo, a clearly fictional stylised 3D cartoon toddler',
  negativePrompt: 'photorealistic child',
  visualSeed: 12345,
  promptRevision: 1,
};

const SCENE: ScriptSceneDraft = {
  index: 0,
  action: 'Baby Leo peers into a puddle',
  voiceover: 'He found the sky in a puddle.',
  onScreenText: 'sky?',
  durationSeconds: 6,
  characterNames: ['Baby Leo'],
  camera: 'slow push-in, low angle',
  mood: 'warm morning light',
};

describe('buildScenePrompt', () => {
  const context = {
    scene: SCENE,
    characters: [LEO],
    visualStyle: 'pastel palette',
    baseNegativePrompt: '',
    width: 1080,
    height: 1920,
  };

  it('leads with the action, which is what the model should depict', () => {
    expect(buildScenePrompt(context).startsWith('Baby Leo peers into a puddle')).toBe(true);
  });

  it('injects the character description verbatim — the consistency mechanism', () => {
    expect(buildScenePrompt(context)).toContain(LEO.promptDescription);
    expect(buildScenePrompt(context)).toContain('mustard dungarees');
  });

  it('carries camera, mood and the vertical framing', () => {
    const prompt = buildScenePrompt(context);
    expect(prompt).toContain('slow push-in, low angle');
    expect(prompt).toContain('warm morning light');
    expect(prompt).toContain('vertical 1080x1920 composition');
  });

  it('always states that the characters are fictional', () => {
    expect(buildScenePrompt(context)).toContain('clearly fictional cartoon characters');
  });

  it('does not repeat a style shared by the scene and the character', () => {
    const prompt = buildScenePrompt({ ...context, visualStyle: 'soft stylised 3D animation' });
    const occurrences = prompt.split('soft stylised 3d animation').length - 1;
    expect(prompt.toLowerCase().split('soft stylised 3d animation').length - 1).toBeLessThanOrEqual(
      1,
    );
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it('produces a usable prompt even with no characters resolved', () => {
    const prompt = buildScenePrompt({ ...context, characters: [] });
    expect(prompt).toContain('Baby Leo peers into a puddle');
    expect(prompt.length).toBeGreaterThan(40);
  });

  it('is deterministic', () => {
    expect(buildScenePrompt(context)).toBe(buildScenePrompt(context));
  });
});

describe('buildSceneSeed', () => {
  it('anchors on the first character seed', () => {
    expect(buildSceneSeed([LEO], 0)).toBe(12345);
  });

  it('offsets per scene so successive scenes are not identical frames', () => {
    expect(buildSceneSeed([LEO], 1)).not.toBe(buildSceneSeed([LEO], 0));
  });

  it('is stable for the same character and index', () => {
    expect(buildSceneSeed([LEO], 3)).toBe(buildSceneSeed([LEO], 3));
  });

  it('returns null when no character carries a seed', () => {
    expect(buildSceneSeed([{ visualSeed: null }], 0)).toBeNull();
    expect(buildSceneSeed([], 0)).toBeNull();
  });
});

describe('buildScenePlans', () => {
  const charactersByName = new Map([['baby leo', LEO]]);

  it('resolves characters case-insensitively', () => {
    const [plan] = buildScenePlans({
      scenes: [{ ...SCENE, characterNames: ['BABY LEO'] }],
      charactersByName,
      visualStyle: '',
      baseNegativePrompt: '',
      width: 1080,
      height: 1920,
    });
    expect(plan?.characterIds).toEqual(['char-leo']);
  });

  it('silently drops a character that is not in the library', () => {
    const [plan] = buildScenePlans({
      scenes: [{ ...SCENE, characterNames: ['Nobody'] }],
      charactersByName,
      visualStyle: '',
      baseNegativePrompt: '',
      width: 1080,
      height: 1920,
    });
    expect(plan?.characterIds).toEqual([]);
  });

  it('always produces a negative prompt guarding against photorealistic children', () => {
    const [plan] = buildScenePlans({
      scenes: [SCENE],
      charactersByName,
      visualStyle: '',
      baseNegativePrompt: '',
      width: 1080,
      height: 1920,
    });
    expect(plan?.negativePrompt).toContain('photorealistic human child');
  });

  it('preserves scene order and duration', () => {
    const plans = buildScenePlans({
      scenes: [SCENE, { ...SCENE, index: 1, durationSeconds: 9 }],
      charactersByName,
      visualStyle: '',
      baseNegativePrompt: '',
      width: 1080,
      height: 1920,
    });
    expect(plans.map((p) => p.index)).toEqual([0, 1]);
    expect(plans[1]?.durationSeconds).toBe(9);
  });
});

describe('fitDurations', () => {
  const draft = (durations: number[]): ScriptDraft => ({
    title: 'T',
    hook: 'H',
    narration: 'N',
    callToAction: '',
    estimatedDurationSeconds: durations.reduce((a, b) => a + b, 0),
    scenes: durations.map((durationSeconds, index) => ({
      ...SCENE,
      index,
      durationSeconds,
    })),
  });

  it('leaves a script already inside the window untouched', () => {
    const result = fitDurations(draft([10, 10, 10]), 15, 60);
    expect(result.scenes.map((s) => s.durationSeconds)).toEqual([10, 10, 10]);
    expect(result.estimatedDurationSeconds).toBe(30);
  });

  it('scales an over-long script down proportionally', () => {
    const result = fitDurations(draft([40, 40, 40]), 15, 60);
    const total = result.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
    expect(total).toBeLessThanOrEqual(61);
    // Proportions are preserved, so pacing survives the rescale.
    expect(result.scenes[0]!.durationSeconds).toBeCloseTo(result.scenes[1]!.durationSeconds, 1);
  });

  it('scales a too-short script up to the minimum', () => {
    const result = fitDurations(draft([2, 2, 2]), 15, 60);
    const total = result.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
    expect(total).toBeGreaterThanOrEqual(14);
  });

  it('never collapses a scene below the renderable floor', () => {
    const result = fitDurations(draft([100, 0.6, 0.6]), 15, 20);
    for (const scene of result.scenes) {
      expect(scene.durationSeconds).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('handles a zero-length script without dividing by zero', () => {
    const result = fitDurations(draft([0, 0]), 15, 60);
    expect(Number.isNaN(result.estimatedDurationSeconds)).toBe(false);
  });
});

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 10, 60)).toBe(10);
    expect(clamp(90, 10, 60)).toBe(60);
    expect(clamp(30, 10, 60)).toBe(30);
  });
});

describe('normalizeMetadata', () => {
  const base = {
    title: 'Baby Leo and the Puddle',
    description: 'A tiny story about a big discovery.',
    hashtags: ['#Cute', 'cute', 'Wholesome!'],
    tags: ['Shorts', 'shorts', ' animation '],
    callToAction: 'Follow for more.',
  };

  it('always includes #shorts first, which is what marks it as a Short', () => {
    expect(normalizeMetadata(base).hashtags[0]).toBe('shorts');
  });

  it('normalises and de-duplicates hashtags', () => {
    const result = normalizeMetadata(base);
    expect(result.hashtags).toContain('cute');
    expect(result.hashtags.filter((tag) => tag === 'cute')).toHaveLength(1);
    expect(result.hashtags.every((tag) => !tag.startsWith('#'))).toBe(true);
  });

  it('de-duplicates tags case-insensitively and trims them', () => {
    const result = normalizeMetadata(base);
    expect(result.tags).toEqual(['Shorts', 'animation']);
  });

  it('appends the AI disclosure exactly once', () => {
    const once = normalizeMetadata(base);
    expect(once.description).toContain(AI_DISCLOSURE);

    const already = normalizeMetadata({
      ...base,
      description: `Something.\n\n${AI_DISCLOSURE}`,
    });
    expect(already.description.split(AI_DISCLOSURE)).toHaveLength(2);
  });

  it('keeps the description within YouTube limits', () => {
    const result = normalizeMetadata({ ...base, description: 'x'.repeat(6000) });
    expect(result.description.length).toBeLessThanOrEqual(5000);
  });

  it('drops hashtags that normalise to nothing', () => {
    const result = normalizeMetadata({ ...base, hashtags: ['###', '!!!'] });
    expect(result.hashtags).toEqual(['shorts']);
  });
});

describe('truncateTitle', () => {
  it('leaves a short title alone', () => {
    expect(truncateTitle('Baby Leo and the Puddle')).toBe('Baby Leo and the Puddle');
  });

  it('enforces the 100-character limit', () => {
    expect(truncateTitle('word '.repeat(40)).length).toBeLessThanOrEqual(100);
  });

  it('cuts on a word boundary when one falls late enough in the budget', () => {
    // Boundary at char 80 of a 100-char limit: worth keeping.
    const title = truncateTitle(`${'a'.repeat(80)} ${'b'.repeat(40)}`);
    expect(title).toBe('a'.repeat(80));
  });

  it('cuts hard when the only boundary is too early to be worth honouring', () => {
    // A boundary at char 50 would discard half the allowance, so the 100-char
    // slice wins instead — losing half a title reads worse than a clipped word.
    const title = truncateTitle(`${'a'.repeat(50)} ${'b'.repeat(60)}`);
    expect(title).toHaveLength(100);
    expect(title.startsWith('a'.repeat(50))).toBe(true);
  });

  it('collapses stray whitespace', () => {
    expect(truncateTitle('  Baby   Leo  ')).toBe('Baby Leo');
  });
});

describe('seedFromName', () => {
  it('is deterministic, so a re-created character keeps its look', () => {
    expect(seedFromName('Baby Leo')).toBe(seedFromName('Baby Leo'));
  });

  it('differs between characters', () => {
    expect(seedFromName('Baby Leo')).not.toBe(seedFromName('Ducky'));
  });

  it('stays inside the range providers accept', () => {
    for (const name of ['Baby Leo', 'Ducky', '🦆', '']) {
      const seed = seedFromName(name);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2_147_483_647);
    }
  });
});

describe('estimateSpeechDuration', () => {
  it('grows with word count', () => {
    expect(estimateSpeechDuration('one two three four five six')).toBeGreaterThan(
      estimateSpeechDuration('one two'),
    );
  });

  it('adds time for sentence pauses', () => {
    expect(estimateSpeechDuration('One. Two. Three.')).toBeGreaterThan(
      estimateSpeechDuration('One two three'),
    );
  });

  it('never returns zero, even for empty text', () => {
    expect(estimateSpeechDuration('')).toBeGreaterThan(0);
  });

  it('shortens as speed increases', () => {
    expect(estimateSpeechDuration('a b c d e f g h', 1.5)).toBeLessThan(
      estimateSpeechDuration('a b c d e f g h', 1),
    );
  });
});

describe('colourFromPrompt', () => {
  it('is deterministic per prompt and seed', () => {
    expect(colourFromPrompt('a garden', 1)).toBe(colourFromPrompt('a garden', 1));
  });

  it('differs between prompts, so scenes are visually distinguishable', () => {
    expect(colourFromPrompt('a garden', 1)).not.toBe(colourFromPrompt('a kitchen', 1));
  });

  it('produces a valid ffmpeg colour literal in the mid range', () => {
    const colour = colourFromPrompt('anything', null);
    expect(colour).toMatch(/^0x[0-9a-f]{6}$/);
    const channels = [1, 3, 5].map((i) => parseInt(colour.slice(i + 1, i + 3), 16));
    for (const channel of channels) {
      expect(channel).toBeGreaterThanOrEqual(60);
      expect(channel).toBeLessThan(200);
    }
  });
});

describe('Replicate adapter helpers', () => {
  it('maps every documented status onto a pipeline state', () => {
    expect(mapStatus('starting')).toBe('queued');
    expect(mapStatus('processing')).toBe('running');
    expect(mapStatus('succeeded')).toBe('succeeded');
    expect(mapStatus('failed')).toBe('failed');
    expect(mapStatus('canceled')).toBe('failed');
  });

  it('reads an output URL from either shape the API returns', () => {
    expect(firstOutputUrl('https://example.com/a.mp4')).toBe('https://example.com/a.mp4');
    expect(firstOutputUrl(['https://example.com/a.mp4', 'b'])).toBe('https://example.com/a.mp4');
    expect(firstOutputUrl([])).toBeNull();
    expect(firstOutputUrl(null)).toBeNull();
  });
});

describe('resumable upload range parsing', () => {
  it('returns the next byte to send, not the last byte received', () => {
    expect(parseRangeHeader('bytes=0-262143')).toBe(262144);
  });

  it('returns null when the server has nothing yet', () => {
    expect(parseRangeHeader(null)).toBeNull();
    expect(parseRangeHeader('')).toBeNull();
    expect(parseRangeHeader('nonsense')).toBeNull();
  });
});

describe('sanitizeTaskId', () => {
  it('keeps only characters Cloud Tasks accepts', () => {
    expect(sanitizeTaskId('abc/def:ghi')).toBe('abc-def-ghi');
  });

  it('bounds the length', () => {
    expect(sanitizeTaskId('x'.repeat(900)).length).toBeLessThanOrEqual(500);
  });
});
