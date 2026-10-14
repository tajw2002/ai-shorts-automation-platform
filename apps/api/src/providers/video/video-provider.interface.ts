import { type Readable } from 'node:stream';
import { type BaseProvider } from '../provider.types';

/**
 * The video-generation port.
 *
 * Generation is asynchronous everywhere in this market, so the port is explicitly
 * a three-step handle/poll/download protocol. That also makes it resumable: the
 * provider job id is persisted, so a worker restart continues polling rather than
 * paying to generate the scene again.
 */

export interface VideoGenerationRequest {
  prompt: string;
  negativePrompt: string | null;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  /** Anchors the look of recurring characters across videos. */
  seed: number | null;
  /** Correlates provider-side jobs with our scenes in support tickets. */
  reference: string;
}

export interface VideoGenerationHandle {
  providerJobId: string;
  provider: string;
  model: string;
  /** Pre-call estimate, recorded before any money is spent. */
  estimatedCostMicros: number;
}

export type VideoGenerationState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface VideoGenerationStatus {
  state: VideoGenerationState;
  /** 0-1 when the provider reports it. */
  progress: number | null;
  /** Present once `state` is `succeeded`. */
  outputUrl: string | null;
  /** Present once `state` is `failed`. */
  error: string | null;
  /** Provider-reported cost, when available. */
  actualCostMicros: number | null;
}

export interface VideoDownload {
  stream: Readable;
  contentType: string;
  /** `null` when the provider does not send a length. */
  sizeBytes: number | null;
}

export interface VideoProvider extends BaseProvider {
  generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationHandle>;
  getGenerationStatus(providerJobId: string): Promise<VideoGenerationStatus>;
  /** Streams the finished asset. Never buffers a whole clip in memory. */
  downloadVideo(outputUrl: string): Promise<VideoDownload>;
  /** Best-effort cancellation, used by the emergency stop. */
  cancelGeneration?(providerJobId: string): Promise<void>;
}
