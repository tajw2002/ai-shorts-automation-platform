import { Injectable } from '@nestjs/common';
import { usdToMicros } from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { ProviderError, ProviderNotConfiguredError } from '@/common/errors';
import { ProviderHttpClient } from '@/common/resilience';
import { errorHealth, okHealth, type ProviderHealth, type ProviderResult } from '../provider.types';
import {
  type SpeechRequest,
  type SpeechResult,
  type VoiceDescriptor,
  type VoiceProvider,
} from './voice-provider.interface';

/**
 * ElevenLabs adapter (verified against the ElevenLabs text-to-speech reference).
 *
 * `POST /v1/text-to-speech/{voice_id}` with an `xi-api-key` header returns raw
 * audio bytes, not JSON. Output format is pinned to 44.1 kHz MP3, which the
 * assembly stage transcodes to AAC — one predictable input beats guessing at the
 * codec the caller happened to configure.
 */

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
const OUTPUT_FORMAT = 'mp3_44100_128';
const DEFAULT_MODEL = 'eleven_multilingual_v2';

interface ElevenLabsVoicesResponse {
  voices?: Array<{
    voice_id: string;
    name?: string;
    labels?: Record<string, string>;
    description?: string;
  }>;
}

@Injectable()
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = 'elevenlabs';
  private readonly http: ProviderHttpClient;

  constructor(private readonly config: AppConfig) {
    this.http = new ProviderHttpClient(this.name, {
      baseUrl: config.voice.baseUrl || ELEVENLABS_BASE_URL,
      headers: { 'xi-api-key': config.voice.apiKey },
      timeoutMs: config.voice.timeoutMs,
      retry: { attempts: 3, baseDelayMs: 1_000, maxDelayMs: 15_000, jitter: true },
    });
  }

  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!this.config.voice.apiKey) missing.push('VOICE_PROVIDER_API_KEY');
    if (!this.config.voice.defaultVoiceId) missing.push('VOICE_DEFAULT_VOICE_ID');
    return missing;
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.config.voice.apiKey) return errorHealth('VOICE_PROVIDER_API_KEY is not set.');
    const startedAt = Date.now();
    try {
      await this.http.request('/voices', { retry: { attempts: 1 } });
      return okHealth('ElevenLabs reachable', Date.now() - startedAt);
    } catch (error) {
      return errorHealth(error instanceof Error ? error.message : 'ElevenLabs unreachable');
    }
  }

  describe(): Record<string, string | number | boolean | null> {
    return {
      model: this.config.voice.model || DEFAULT_MODEL,
      defaultVoiceId: this.config.voice.defaultVoiceId || null,
      outputFormat: OUTPUT_FORMAT,
      costPer1kChars: this.config.voice.costPer1kChars,
    };
  }

  async generateSpeech(request: SpeechRequest): Promise<ProviderResult<SpeechResult>> {
    const missing = this.missingConfiguration();
    if (missing.length > 0) throw new ProviderNotConfiguredError('VOICE', this.name, missing);

    const voiceId = request.voiceId || this.config.voice.defaultVoiceId;
    const model = this.config.voice.model || DEFAULT_MODEL;

    const response = await this.http.request<Buffer | string>(
      `/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
      {
        method: 'POST',
        headers: { accept: 'audio/mpeg' },
        body: {
          text: request.text,
          model_id: model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            // The API takes speed directly; clamped to the documented range.
            speed: Math.min(1.2, Math.max(0.7, request.speed)),
          },
        },
      },
    );

    const audio = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(String(response.data), 'binary');

    if (audio.length === 0) {
      throw new ProviderError({
        provider: this.name,
        message: 'Speech synthesis returned an empty audio body.',
        retryable: true,
      });
    }

    return {
      data: {
        audio,
        contentType: 'audio/mpeg',
        // ElevenLabs does not report duration on this endpoint; the pipeline
        // probes the file with ffprobe, which is authoritative anyway.
        durationSeconds: null,
        characters: request.text.length,
      },
      usage: {
        units: request.text.length,
        unitLabel: 'characters',
        actualCostMicros: usdToMicros(
          (request.text.length / 1000) * this.config.voice.costPer1kChars,
        ),
      },
      model,
    };
  }

  async listVoices(): Promise<VoiceDescriptor[]> {
    const response = await this.http.request<ElevenLabsVoicesResponse>('/voices');
    return (response.data.voices ?? []).map((voice) => ({
      id: voice.voice_id,
      name: voice.name ?? voice.voice_id,
      language: voice.labels?.language ?? 'unknown',
      description: voice.description ?? '',
    }));
  }
}
