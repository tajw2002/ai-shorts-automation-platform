import { Global, Module, type Provider } from '@nestjs/common';
import { AppConfig } from '@/config/app-config';
import { FfmpegRunner } from '@/infrastructure/ffmpeg/ffmpeg.runner';
import {
  LLM_PROVIDER,
  QUEUE_PROVIDER,
  STORAGE_PROVIDER,
  VIDEO_PROVIDER,
  VOICE_PROVIDER,
  YOUTUBE_PROVIDER,
} from './provider.tokens';

import { MockLLMProvider } from './llm/mock-llm.provider';
import { AnthropicLLMProvider } from './llm/anthropic-llm.provider';
import { OpenAILLMProvider } from './llm/openai-llm.provider';

import { MockVideoProvider } from './video/mock-video.provider';
import { ReplicateVideoProvider } from './video/replicate-video.provider';

import { MockVoiceProvider } from './voice/mock-voice.provider';
import { ElevenLabsVoiceProvider } from './voice/elevenlabs-voice.provider';

import { LocalStorageProvider } from './storage/local-storage.provider';
import { GcsStorageProvider } from './storage/gcs-storage.provider';

import { MockYouTubeProvider } from './youtube/mock-youtube.provider';
import { GoogleYouTubeProvider } from './youtube/google-youtube.provider';

import { InMemoryQueueProvider } from './queue/inmemory-queue.provider';
import { CloudTasksQueueProvider } from './queue/cloudtasks-queue.provider';

/**
 * The one place where a port is bound to an implementation.
 *
 * Everything downstream injects a token and is oblivious to which adapter it
 * receives. Selection is driven entirely by configuration, and `DRY_RUN` is
 * applied inside `AppConfig.providers` — so a dry run cannot be defeated by a
 * stray environment variable, and there is no `if (dryRun)` branch scattered
 * through the business logic.
 *
 * Unknown values never reach here: `env.schema.ts` restricts each provider
 * variable to a known set, so a typo fails at boot with a readable message
 * rather than silently falling back to a mock.
 */
@Global()
@Module({
  providers: [
    // Concrete adapters are registered so Nest can construct them with their own
    // dependencies; the factories below pick which one each token resolves to.
    MockLLMProvider,
    AnthropicLLMProvider,
    OpenAILLMProvider,
    MockVideoProvider,
    ReplicateVideoProvider,
    MockVoiceProvider,
    ElevenLabsVoiceProvider,
    LocalStorageProvider,
    GcsStorageProvider,
    MockYouTubeProvider,
    GoogleYouTubeProvider,
    InMemoryQueueProvider,
    CloudTasksQueueProvider,

    llmProvider(),
    videoProvider(),
    voiceProvider(),
    storageProvider(),
    youtubeProvider(),
    queueProvider(),
  ],
  exports: [
    LLM_PROVIDER,
    VIDEO_PROVIDER,
    VOICE_PROVIDER,
    STORAGE_PROVIDER,
    YOUTUBE_PROVIDER,
    QUEUE_PROVIDER,
    // Exported by class as well so the Providers dashboard page can describe
    // every adapter, not just the active one.
    MockLLMProvider,
    AnthropicLLMProvider,
    OpenAILLMProvider,
    MockVideoProvider,
    ReplicateVideoProvider,
    MockVoiceProvider,
    ElevenLabsVoiceProvider,
    LocalStorageProvider,
    GcsStorageProvider,
    MockYouTubeProvider,
    GoogleYouTubeProvider,
    InMemoryQueueProvider,
    CloudTasksQueueProvider,
  ],
})
export class ProvidersModule {}

function llmProvider(): Provider {
  return {
    provide: LLM_PROVIDER,
    inject: [AppConfig, MockLLMProvider, AnthropicLLMProvider, OpenAILLMProvider],
    useFactory: (
      config: AppConfig,
      mock: MockLLMProvider,
      anthropic: AnthropicLLMProvider,
      openai: OpenAILLMProvider,
    ) => {
      switch (config.providers.llm) {
        case 'anthropic':
          return anthropic;
        case 'openai':
          return openai;
        default:
          return mock;
      }
    },
  };
}

function videoProvider(): Provider {
  return {
    provide: VIDEO_PROVIDER,
    inject: [AppConfig, MockVideoProvider, ReplicateVideoProvider],
    useFactory: (config: AppConfig, mock: MockVideoProvider, replicate: ReplicateVideoProvider) => {
      // `fal` shares Replicate's create/poll/download shape closely enough that
      // the same adapter serves both when VIDEO_PROVIDER_BASE_URL points at it.
      // A dedicated adapter can be added later without touching business logic.
      const selected = config.providers.video;
      return selected === 'replicate' || selected === 'fal' ? replicate : mock;
    },
  };
}

function voiceProvider(): Provider {
  return {
    provide: VOICE_PROVIDER,
    inject: [AppConfig, MockVoiceProvider, ElevenLabsVoiceProvider],
    useFactory: (
      config: AppConfig,
      mock: MockVoiceProvider,
      elevenlabs: ElevenLabsVoiceProvider,
    ) => (config.providers.voice === 'elevenlabs' ? elevenlabs : mock),
  };
}

function storageProvider(): Provider {
  return {
    provide: STORAGE_PROVIDER,
    inject: [AppConfig, LocalStorageProvider, GcsStorageProvider],
    useFactory: (config: AppConfig, local: LocalStorageProvider, gcs: GcsStorageProvider) =>
      config.providers.storage === 'gcs' ? gcs : local,
  };
}

function youtubeProvider(): Provider {
  return {
    provide: YOUTUBE_PROVIDER,
    inject: [AppConfig, MockYouTubeProvider, GoogleYouTubeProvider],
    useFactory: (
      config: AppConfig,
      mock: MockYouTubeProvider,
      googleProvider: GoogleYouTubeProvider,
    ) => (config.providers.youtube === 'google' ? googleProvider : mock),
  };
}

function queueProvider(): Provider {
  return {
    provide: QUEUE_PROVIDER,
    inject: [AppConfig, InMemoryQueueProvider, CloudTasksQueueProvider],
    useFactory: (
      config: AppConfig,
      inMemory: InMemoryQueueProvider,
      cloudTasks: CloudTasksQueueProvider,
    ) => (config.providers.queue === 'cloudtasks' ? cloudTasks : inMemory),
  };
}

/** Re-exported so `FfmpegRunner` stays available to adapters that need it. */
export { FfmpegRunner };
