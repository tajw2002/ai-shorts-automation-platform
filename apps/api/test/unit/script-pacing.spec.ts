import {
  buildScriptUserPrompt,
  narrationBudgetRule,
  scenePacingRule,
} from '@/providers/llm/prompts/content-prompts';

/**
 * Scene pacing in the script prompt.
 *
 * A real script put six scenes into 23.7 s of narration; two were spoken in 2-3 s but
 * each still cost the video model's 4 s minimum clip. The model was never told that
 * limit, so it had no reason to write fewer, fuller scenes.
 */

const idea = {
  title: 'Baby Leo and the Dandelion Wish',
  premise: 'Leo blows a dandelion and Ducky chases the seeds.',
  hook: 'Where do wishes go?',
  beats: ['Leo finds a dandelion', 'The seeds fly', 'Ducky follows them'],
  characterNames: ['Baby Leo', 'Ducky'],
  tone: 'cozy',
  targetDurationSeconds: 25,
  noveltyRationale: 'First outdoor story.',
};

const base = {
  idea,
  characters: [],
  language: 'en',
  targetDurationSeconds: 25,
  minDurationSeconds: 15,
  maxDurationSeconds: 60,
  avoidNarrations: [],
};

describe('scenePacingRule', () => {
  it('states the minimum spoken length per scene and a word count', () => {
    const rule = scenePacingRule(4);
    expect(rule).toContain('at least 4s');
    expect(rule).toContain('at least 10 words');
  });

  it.each([undefined, 0])('adds nothing when the model has no minimum (%p)', (value) => {
    expect(scenePacingRule(value)).toBe('');
  });
});

describe('buildScriptUserPrompt', () => {
  it('tells the model about the clip minimum', () => {
    expect(buildScriptUserPrompt({ ...base, minSceneSeconds: 4 } as never)).toContain(
      "every scene's voiceover must take at least 4s",
    );
  });

  it('leaves the prompt unchanged without a minimum', () => {
    expect(buildScriptUserPrompt(base as never)).not.toContain('Pacing:');
  });
});

describe('narrationBudgetRule', () => {
  it('turns the duration target into a word budget with a hard ceiling', () => {
    const rule = narrationBudgetRule(25, 60);
    expect(rule).toContain('about 63 words');
    expect(rule).toContain('never more than 150 words');
  });

  it('is part of every script prompt', () => {
    expect(buildScriptUserPrompt(base as never)).toContain('about 63 words');
  });
});
