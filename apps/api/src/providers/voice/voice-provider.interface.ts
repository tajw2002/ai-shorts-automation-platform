import { type BaseProvider, type ProviderResult } from '../provider.types';

export interface SpeechRequest {
  text: string;
  /** Provider-specific voice identifier; falls back to the configured default. */
  voiceId: string | null;
  /** 1.0 is natural speed. */
  speed: number;
  language: string;
  /** Correlates the request with the video it belongs to. */
  reference: string;
}

export interface SpeechResult {
  audio: Buffer;
  contentType: string;
  /** Measured by the provider when it reports one; otherwise the pipeline probes it. */
  durationSeconds: number | null;
  characters: number;
}

export interface VoiceDescriptor {
  id: string;
  name: string;
  language: string;
  description: string;
}

export interface VoiceProvider extends BaseProvider {
  generateSpeech(request: SpeechRequest): Promise<ProviderResult<SpeechResult>>;
  listVoices(): Promise<VoiceDescriptor[]>;
}
