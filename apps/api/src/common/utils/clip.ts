/**
 * Clamps a scene's clip length to what the selected video model accepts.
 *
 * `0` means "no limit" for either bound. The clamped value is what gets billed,
 * so callers must use it for the cost estimate as well as for the request.
 */
export function clampClipSeconds(seconds: number, min: number, max: number): number {
  const atLeastMin = min > 0 ? Math.max(seconds, min) : seconds;
  return max > 0 ? Math.min(atLeastMin, max) : atLeastMin;
}
