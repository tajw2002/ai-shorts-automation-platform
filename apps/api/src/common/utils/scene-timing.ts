/**
 * Splits the measured narration length across scenes in proportion to how much
 * each scene says.
 *
 * The narration is one continuous recording of every scene's voiceover joined
 * together, so a scene with twice the text takes roughly twice as long to speak.
 * Giving each scene that share keeps three things in step that used to drift:
 * the captions (timed per scene), the pictures (cut per scene), and the voice.
 *
 * A scene without voiceover still needs screen time, so it gets half the average
 * weight of a speaking scene. Durations are rounded to centiseconds; the last scene
 * absorbs the rounding so the total equals the narration exactly.
 */
export function alignSceneDurations(voiceovers: string[], narrationSeconds: number): number[] {
  if (voiceovers.length === 0) return [];
  if (!(narrationSeconds > 0)) throw new RangeError('narrationSeconds must be positive.');

  const lengths = voiceovers.map((text) => text.trim().length);
  const speaking = lengths.filter((length) => length > 0);
  const silentWeight =
    speaking.length > 0 ? (speaking.reduce((a, b) => a + b, 0) / speaking.length) * 0.5 : 1;
  const weights = lengths.map((length) => (length > 0 ? length : silentWeight));
  const total = weights.reduce((a, b) => a + b, 0);

  const durations = weights.map(
    (weight) => Math.round(((narrationSeconds * weight) / total) * 100) / 100,
  );
  const assigned = durations.slice(0, -1).reduce((a, b) => a + b, 0);
  durations[durations.length - 1] = Math.round((narrationSeconds - assigned) * 100) / 100;
  return durations;
}
