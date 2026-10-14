import { alignSceneDurations } from '@/common/utils/scene-timing';
import { clampClipSeconds } from '@/common/utils/clip';

/**
 * Narration-aligned scene timing.
 *
 * The first real video planned 38 s of scenes for 23 s of speech. The render stops
 * with the voice, so roughly 40 % of the paid clip seconds were thrown away, the
 * closing scene was never shown, and captions timed from the plan lagged the voice.
 */

const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

describe('alignSceneDurations', () => {
  it('gives each scene a share proportional to its text', () => {
    const durations = alignSceneDurations(['aaaa', 'aaaaaaaa'], 12);
    expect(durations).toEqual([4, 8]);
  });

  it('sums exactly to the narration length, whatever the rounding', () => {
    const durations = alignSceneDurations(['one', 'two two', 'three three three'], 22.83);
    expect(sum(durations)).toBe(22.83);
  });

  it('reproduces the real case: five scenes over 22.8 s instead of a 38 s plan', () => {
    const voiceovers = [
      'Look, Leo! Your shadow is dancing on the wall.',
      'Ducky waddles over, flapping his wings into a funny shape.',
      'Now they take turns, giggling at every silly new animal.',
      'Hold hands, and watch — a big shadow heart glows warm between them.',
      'Sleepy eyes, soft yawns, the shadows settle down to dream.',
    ];
    const durations = alignSceneDurations(voiceovers, 22.83);
    expect(sum(durations)).toBe(22.83);
    // Every scene, including the last, now gets screen time while it is spoken.
    for (const seconds of durations) expect(seconds).toBeGreaterThan(3.5);
    // And the clips to order cost far less than the 38 s that were planned.
    const ordered = durations.map((s) => clampClipSeconds(Math.ceil(s), 4, 12));
    expect(sum(ordered)).toBeLessThan(28);
  });

  it('keeps a silent scene on screen with half the average weight', () => {
    const durations = alignSceneDurations(['aaaa', '', 'aaaa'], 10);
    expect(durations).toEqual([4, 2, 4]);
  });

  it('splits evenly when no scene has voiceover', () => {
    expect(alignSceneDurations(['', ''], 9)).toEqual([4.5, 4.5]);
  });

  it('ignores surrounding whitespace when weighing text', () => {
    expect(alignSceneDurations(['  aaaa  ', 'aaaa'], 8)).toEqual([4, 4]);
  });

  it('returns nothing for no scenes', () => {
    expect(alignSceneDurations([], 10)).toEqual([]);
  });

  it.each([0, -1, Number.NaN])('rejects a narration length of %p', (seconds) => {
    expect(() => alignSceneDurations(['a'], seconds)).toThrow(RangeError);
  });
});
