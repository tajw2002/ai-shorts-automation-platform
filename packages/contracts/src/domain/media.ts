import { z } from 'zod';

/** Target encoding profile for the final render. */
export const videoFormatSpecSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  videoCodec: z.literal('h264'),
  audioCodec: z.literal('aac'),
  container: z.literal('mp4'),
  minDurationSeconds: z.number().positive(),
  maxDurationSeconds: z.number().positive(),
  loudnessTargetLufs: z.number(),
});
export type VideoFormatSpec = z.infer<typeof videoFormatSpecSchema>;

export const DEFAULT_VIDEO_FORMAT: VideoFormatSpec = Object.freeze({
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  container: 'mp4',
  minDurationSeconds: 15,
  maxDurationSeconds: 60,
  loudnessTargetLufs: -14,
});

/** Normalised subset of `ffprobe` output that the platform reasons about. */
export interface MediaProbeResult {
  durationSeconds: number;
  sizeBytes: number;
  formatName: string;
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number;
    bitRate: number | null;
  } | null;
  audio: {
    codec: string;
    sampleRate: number;
    channels: number;
    bitRate: number | null;
  } | null;
}

export interface SubtitleCue {
  index: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export const subtitleStyleSchema = z.object({
  name: z.string(),
  fontFamily: z.string(),
  fontSizePx: z.number().int().positive(),
  primaryColor: z.string(),
  outlineColor: z.string(),
  outlineWidthPx: z.number().nonnegative(),
  shadowPx: z.number().nonnegative(),
  bold: z.boolean(),
  uppercase: z.boolean(),
  /**
   * Distance from the bottom of the frame as a percentage of frame height.
   * Must stay clear of the Shorts UI (title, avatar, action rail) — ~20-25%.
   */
  bottomMarginPercent: z.number().min(0).max(60),
  maxCharsPerLine: z.number().int().positive(),
  maxLines: z.number().int().positive(),
});
export type SubtitleStyle = z.infer<typeof subtitleStyleSchema>;
