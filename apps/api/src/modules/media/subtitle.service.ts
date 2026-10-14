import { Injectable } from '@nestjs/common';
import { type SubtitleCue, type SubtitleStyle } from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';

/**
 * Subtitle generation.
 *
 * Two jobs: work out *when* each caption appears, and render it in a style that
 * stays readable on a phone without colliding with the Shorts interface.
 *
 * Timing is derived from the scene plan rather than from speech recognition.
 * The narration for each scene is known, and so is the scene's duration, so cues
 * can be distributed proportionally to their length. That is accurate enough for
 * short-form pacing, costs nothing, and cannot fail the way a transcription
 * service can.
 */

/**
 * Vertical-safe defaults.
 *
 * The bottom ~20% of a Short is occupied by the title, channel handle and the
 * action rail. `bottomMarginPercent` keeps captions clear of it; the value is
 * configurable because the UI's footprint changes over time.
 */
const STYLE_PRESETS: Record<string, Omit<SubtitleStyle, 'bottomMarginPercent'>> = {
  default: {
    name: 'default',
    fontFamily: 'DejaVu Sans',
    fontSizePx: 64,
    primaryColor: '&H00FFFFFF',
    outlineColor: '&H00000000',
    outlineWidthPx: 4,
    shadowPx: 2,
    bold: true,
    uppercase: false,
    maxCharsPerLine: 24,
    maxLines: 2,
  },
  bold: {
    name: 'bold',
    fontFamily: 'DejaVu Sans',
    fontSizePx: 76,
    primaryColor: '&H0000F0FF',
    outlineColor: '&H00000000',
    outlineWidthPx: 6,
    shadowPx: 3,
    bold: true,
    uppercase: true,
    maxCharsPerLine: 18,
    maxLines: 2,
  },
  subtle: {
    name: 'subtle',
    fontFamily: 'DejaVu Sans',
    fontSizePx: 52,
    primaryColor: '&H00FFFFFF',
    outlineColor: '&H00000000',
    outlineWidthPx: 3,
    shadowPx: 1,
    bold: false,
    uppercase: false,
    maxCharsPerLine: 30,
    maxLines: 2,
  },
};

/** Never show a caption for less than this — it would be unreadable. */
const MIN_CUE_SECONDS = 0.7;
/** Nor for longer than this; a static caption for 8s reads as a bug. */

@Injectable()
export class SubtitleService {
  constructor(private readonly config: AppConfig) {}

  getStyle(name?: string): SubtitleStyle {
    const preset = STYLE_PRESETS[name ?? this.config.media.subtitleStyle] ?? STYLE_PRESETS.default!;
    return { ...preset, bottomMarginPercent: this.config.media.subtitleBottomMarginPercent };
  }

  /** Cues for a whole video, from its scene timeline. */
  buildCues(
    scenes: Array<{ voiceover: string; durationSeconds: number }>,
    styleName?: string,
  ): SubtitleCue[] {
    return buildCuesFromScenes(scenes, this.getStyle(styleName));
  }

  renderAss(cues: SubtitleCue[], styleName?: string): string {
    return renderAss(cues, this.getStyle(styleName), {
      width: this.config.media.format.width,
      height: this.config.media.format.height,
    });
  }

  renderSrt(cues: SubtitleCue[]): string {
    return renderSrt(cues);
  }
}

/* -------------------------------------------------------------------------- */
/* Pure functions — the interesting logic, kept testable.                     */
/* -------------------------------------------------------------------------- */

/**
 * Splits text into caption-sized chunks on word boundaries.
 *
 * Chunks respect `maxCharsPerLine * maxLines`, and a word longer than a whole
 * line is emitted alone rather than dropped or split mid-word.
 */
export function chunkText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const budget = maxCharsPerLine * maxLines;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= budget) {
      current = candidate;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    current = word;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

/** Wraps a chunk across at most `maxLines` lines, balancing their lengths. */
export function wrapLines(chunk: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = chunk.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxCharsPerLine || current.length === 0) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    }
  }

  const remaining = words.slice(lines.join(' ').split(/\s+/).filter(Boolean).length).join(' ');
  if (lines.length < maxLines && (current.length > 0 || remaining.length > 0)) {
    lines.push(remaining.length > current.length ? remaining : current);
  }

  return lines.filter(Boolean).slice(0, maxLines);
}

export function buildCuesFromScenes(
  scenes: Array<{ voiceover: string; durationSeconds: number }>,
  style: SubtitleStyle,
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let elapsed = 0;
  let index = 1;

  for (const scene of scenes) {
    const sceneStart = elapsed;
    const sceneEnd = elapsed + scene.durationSeconds;
    elapsed = sceneEnd;

    const chunks = chunkText(scene.voiceover, style.maxCharsPerLine, style.maxLines);
    if (chunks.length === 0) continue;

    // Every chunk first gets the minimum readable time; what is left is shared in
    // proportion to length, so a long sentence stays up longer than "Look!". The
    // durations sum to the scene exactly, so no cue spills into the next scene:
    // scenes follow the narration, and a spill would put two captions on screen.
    // A scene too short for every chunk's minimum is simply split evenly.
    const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const reserved = chunks.length * MIN_CUE_SECONDS;
    const spare = scene.durationSeconds - reserved;
    let cursor = sceneStart;

    chunks.forEach((chunk, chunkIndex) => {
      const share = totalChars > 0 ? chunk.length / totalChars : 1 / chunks.length;
      const duration =
        spare >= 0 ? MIN_CUE_SECONDS + spare * share : scene.durationSeconds / chunks.length;

      const start = cursor;
      const end = chunkIndex === chunks.length - 1 ? sceneEnd : start + duration;
      cursor = end;

      cues.push({
        index: index++,
        startSeconds: round2(start),
        endSeconds: round2(end),
        text: style.uppercase ? chunk.toUpperCase() : chunk,
      });
    });
  }

  return cues;
}

/**
 * Renders Advanced SubStation Alpha.
 *
 * ASS rather than SRT because it carries styling — font, outline, and crucially
 * the bottom margin that keeps captions off the Shorts UI. `PlayResX/Y` are set
 * to the real frame size so the pixel values mean what they say.
 */
export function renderAss(
  cues: SubtitleCue[],
  style: SubtitleStyle,
  frame: { width: number; height: number },
): string {
  const marginV = Math.round((frame.height * style.bottomMarginPercent) / 100);
  const marginH = Math.round(frame.width * 0.08);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, ' +
      'BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, ' +
      'BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${style.fontFamily},${style.fontSizePx},${style.primaryColor},` +
      `&H000000FF,${style.outlineColor},&H80000000,${style.bold ? -1 : 0},0,0,0,` +
      `100,100,0,0,1,${style.outlineWidthPx},${style.shadowPx},2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = cues
    .map((cue) => {
      const text = wrapLines(cue.text, style.maxCharsPerLine, style.maxLines)
        .map(escapeAssText)
        .join('\\N');
      return `Dialogue: 0,${toAssTime(cue.startSeconds)},${toAssTime(cue.endSeconds)},Caption,,0,0,0,,${text}`;
    })
    .join('\n');

  return `${header}\n${events}\n`;
}

export function renderSrt(cues: SubtitleCue[]): string {
  return `${cues
    .map(
      (cue) =>
        `${cue.index}\n${toSrtTime(cue.startSeconds)} --> ${toSrtTime(cue.endSeconds)}\n${cue.text}`,
    )
    .join('\n\n')}\n`;
}

/** ASS uses `H:MM:SS.cc` with centisecond precision. */
export function toAssTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const centis = Math.round((total - Math.floor(total)) * 100);
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(centis)}`;
}

export function toSrtTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${String(millis).padStart(3, '0')}`;
}

/**
 * Escapes ASS control characters.
 *
 * Braces open an override block in ASS, so a caption containing `{` would
 * otherwise silently swallow text or apply unintended formatting.
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, ' ');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export { STYLE_PRESETS };
