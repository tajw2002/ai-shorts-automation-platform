import { Injectable } from '@nestjs/common';
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FfmpegRunner } from '@/infrastructure/ffmpeg/ffmpeg.runner';
import { errorHealth, okHealth, type ProviderHealth, type ProviderResult } from '../provider.types';
import {
  type SpeechRequest,
  type SpeechResult,
  type VoiceDescriptor,
  type VoiceProvider,
} from './voice-provider.interface';

/**
 * Synthesises a speech-shaped placeholder track.
 *
 * As with the mock video provider, the point is to emit *real* audio of a
 * realistic duration: the mix, the loudness normalisation and the subtitle timing
 * all then run for real during a dry run. A tremolo-modulated tone approximates
 * the envelope of speech closely enough for loudnorm to behave sensibly.
 */

/** Average narration pace. Used to derive a plausible duration from the text. */
const WORDS_PER_SECOND = 2.7;

@Injectable()
export class MockVoiceProvider implements VoiceProvider {
  readonly name = 'mock';

  constructor(private readonly ffmpeg: FfmpegRunner) {}

  isConfigured(): boolean {
    return true;
  }

  missingConfiguration(): string[] {
    return [];
  }

  async healthCheck(): Promise<ProviderHealth> {
    const availability = await this.ffmpeg.checkAvailability();
    return availability.available
      ? okHealth('Mock voice provider — synthesises local placeholder audio.', 0)
      : errorHealth(`Mock voice provider needs ffmpeg. ${availability.message}`);
  }

  describe(): Record<string, string | number | boolean | null> {
    return { model: 'mock-voice-v1', wordsPerSecond: WORDS_PER_SECOND, cost: 0 };
  }

  async generateSpeech(request: SpeechRequest): Promise<ProviderResult<SpeechResult>> {
    const durationSeconds = estimateSpeechDuration(request.text, request.speed);
    const dir = join(tmpdir(), 'shorts-mock-voice');
    await mkdir(dir, { recursive: true });

    const fingerprint = createHash('sha256')
      .update(`${request.reference}|${request.text}|${request.voiceId ?? ''}`)
      .digest('hex')
      .slice(0, 16);
    const outputPath = join(dir, `${fingerprint}.wav`);

    // Pitch varies with the chosen voice id so different characters sound
    // different, which makes a dry-run render easier to sanity-check by ear.
    const baseFrequency = 150 + (hashToInt(request.voiceId ?? 'default') % 120);

    await this.ffmpeg.runFfmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${baseFrequency}:sample_rate=48000:duration=${durationSeconds.toFixed(2)}`,
        '-af',
        'tremolo=f=4.5:d=0.85,volume=0.25',
        '-c:a',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        '48000',
        outputPath,
      ],
      { label: `mock-voice:${fingerprint}`, timeoutMs: 60_000 },
    );

    const audio = await readFile(outputPath);
    await unlink(outputPath).catch(() => undefined);

    return {
      data: {
        audio,
        contentType: 'audio/wav',
        durationSeconds,
        characters: request.text.length,
      },
      usage: { units: request.text.length, unitLabel: 'characters' },
      model: 'mock-voice-v1',
    };
  }

  async listVoices(): Promise<VoiceDescriptor[]> {
    return [
      { id: 'mock-warm', name: 'Warm Narrator', language: 'en', description: 'Soft, low pitch.' },
      {
        id: 'mock-bright',
        name: 'Bright Narrator',
        language: 'en',
        description: 'Higher, lively.',
      },
      { id: 'mock-child', name: 'Playful', language: 'en', description: 'Light and quick.' },
    ];
  }
}

/**
 * Estimated narration duration in seconds.
 *
 * Exported because the scene planner uses the same estimate to keep the visual
 * timeline and the voice track roughly aligned before any audio exists.
 */
export function estimateSpeechDuration(text: string, speed = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0.5;
  const seconds = words / (WORDS_PER_SECOND * Math.max(0.5, speed));
  // Sentence boundaries add natural pauses.
  const pauses = (text.match(/[.!?]/g)?.length ?? 0) * 0.25;
  return Math.max(0.5, Math.round((seconds + pauses) * 100) / 100);
}

function hashToInt(value: string): number {
  return createHash('sha256').update(value).digest().readUInt16BE(0);
}
