import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { type ZodType } from 'zod';
import {
  type ContentIdeaDraft,
  type PerformanceAnalysisResult,
  type SafetyAssessment,
  type ScriptDraft,
  type VideoMetadataDraft,
  usdToMicros,
} from '@shorts/contracts';
import { AppConfig } from '@/config/app-config';
import { ProviderError, ProviderNotConfiguredError } from '@/common/errors';
import { errorHealth, okHealth, type ProviderHealth, type ProviderResult } from '../provider.types';
import {
  type AnalyzePerformanceInput,
  type GenerateIdeasInput,
  type GenerateMetadataInput,
  type GenerateScriptInput,
  type LLMProvider,
  type ModerationInput,
} from './llm-provider.interface';
import * as prompts from './prompts/content-prompts';

/**
 * OpenAI adapter.
 *
 * Mirrors the Anthropic adapter's contract exactly: the Responses API with a
 * strict JSON schema derived from the same zod schemas, so switching
 * `LLM_PROVIDER` changes nothing the domain can observe apart from wording.
 */
@Injectable()
export class OpenAILLMProvider implements LLMProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;

  constructor(private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  missingConfiguration(): string[] {
    return this.config.llm.apiKey ? [] : ['LLM_API_KEY'];
  }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.isConfigured()) return errorHealth('LLM_API_KEY is not set.');
    const startedAt = Date.now();
    try {
      await this.sdk().models.retrieve(this.config.llm.model);
      return okHealth(`Model ${this.config.llm.model} reachable`, Date.now() - startedAt);
    } catch (error) {
      return errorHealth(error instanceof Error ? error.message : 'Unknown OpenAI failure');
    }
  }

  describe(): Record<string, string | number | boolean | null> {
    return {
      model: this.config.llm.model,
      maxOutputTokens: this.config.llm.maxOutputTokens,
      timeoutMs: this.config.llm.timeoutMs,
    };
  }

  async generateIdeas(input: GenerateIdeasInput): Promise<ProviderResult<ContentIdeaDraft[]>> {
    const result = await this.parse(
      prompts.buildIdeasSystemPrompt(),
      prompts.buildIdeasUserPrompt(input),
      prompts.ideasResponseSchema,
      'ideas',
      'generateIdeas',
    );
    return { ...result, data: result.data.ideas };
  }

  async generateScript(input: GenerateScriptInput): Promise<ProviderResult<ScriptDraft>> {
    return this.parse(
      prompts.buildScriptSystemPrompt(),
      prompts.buildScriptUserPrompt(input),
      prompts.scriptResponseSchema,
      'script',
      'generateScript',
    );
  }

  async generateMetadata(
    input: GenerateMetadataInput,
  ): Promise<ProviderResult<VideoMetadataDraft>> {
    return this.parse(
      prompts.buildMetadataSystemPrompt(),
      prompts.buildMetadataUserPrompt(input),
      prompts.metadataResponseSchema,
      'metadata',
      'generateMetadata',
    );
  }

  async analyzePerformance(
    input: AnalyzePerformanceInput,
  ): Promise<ProviderResult<PerformanceAnalysisResult>> {
    const result = await this.parse(
      prompts.buildPerformanceSystemPrompt(),
      prompts.buildPerformanceUserPrompt(input),
      prompts.performanceResponseSchema,
      'performance',
      'analyzePerformance',
    );

    return {
      ...result,
      data: {
        insights: result.data.insights.map((insight) => ({ ...insight })),
        sampleSize: input.videos.length,
        analyzedAt: new Date().toISOString(),
        summary: result.data.summary,
      },
    };
  }

  async moderate(input: ModerationInput): Promise<ProviderResult<SafetyAssessment>> {
    const result = await this.parse(
      prompts.buildModerationSystemPrompt(),
      prompts.buildModerationUserPrompt(input),
      prompts.moderationResponseSchema,
      'moderation',
      'moderate',
    );

    return {
      ...result,
      data: {
        verdict: result.data.verdict,
        findings: result.data.findings.map((finding) => ({
          category: finding.category,
          confidence: finding.confidence,
          reason: finding.reason,
        })),
        evaluators: ['openai'],
        evaluatedAt: new Date().toISOString(),
      },
    };
  }

  // -- internals ------------------------------------------------------------

  private sdk(): OpenAI {
    if (!this.config.llm.apiKey) {
      throw new ProviderNotConfiguredError('LLM', this.name, this.missingConfiguration());
    }
    this.client ??= new OpenAI({
      apiKey: this.config.llm.apiKey,
      timeout: this.config.llm.timeoutMs,
      // Retries are owned by the resilience layer, not the SDK, so backoff and
      // budget accounting stay in one place.
      maxRetries: 0,
    });
    return this.client;
  }

  private async parse<T>(
    instructions: string,
    input: string,
    schema: ZodType<T>,
    schemaName: string,
    operation: string,
  ): Promise<ProviderResult<T>> {
    try {
      const response = await this.sdk().responses.parse({
        model: this.config.llm.model,
        instructions,
        input,
        max_output_tokens: this.config.llm.maxOutputTokens,
        text: { format: zodTextFormat(schema, schemaName) },
      });

      if (response.output_parsed === null || response.output_parsed === undefined) {
        throw new ProviderError({
          provider: this.name,
          message: `${operation}: the response did not satisfy the expected schema.`,
          retryable: true,
          details: { status: response.status },
        });
      }

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;

      return {
        data: response.output_parsed as T,
        model: response.model,
        correlationId: response.id,
        usage: {
          units: inputTokens + outputTokens,
          unitLabel: 'tokens',
          inputTokens,
          outputTokens,
          actualCostMicros: usdToMicros(
            (inputTokens / 1_000_000) * this.config.llm.inputCostPerMTok +
              (outputTokens / 1_000_000) * this.config.llm.outputCostPerMTok,
          ),
        },
      };
    } catch (error) {
      throw this.toProviderError(error, operation);
    }
  }

  private toProviderError(error: unknown, operation: string): Error {
    if (error instanceof ProviderError) return error;

    if (error instanceof OpenAI.RateLimitError) {
      return new ProviderError({
        provider: this.name,
        message: `${operation}: rate limited.`,
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof OpenAI.APIConnectionError) {
      return new ProviderError({
        provider: this.name,
        message: `${operation}: connection failure.`,
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof OpenAI.AuthenticationError) {
      return new ProviderError({
        provider: this.name,
        message: `${operation}: authentication failed. Check LLM_API_KEY.`,
        retryable: false,
        cause: error,
      });
    }
    if (error instanceof OpenAI.APIError) {
      const status = error.status ?? 0;
      return new ProviderError({
        provider: this.name,
        message: `${operation}: API error ${status}.`,
        retryable: status === 408 || status === 429 || status >= 500,
        cause: error,
      });
    }
    return new ProviderError({
      provider: this.name,
      message: `${operation}: ${error instanceof Error ? error.message : 'unknown failure'}`,
      retryable: true,
      cause: error,
    });
  }
}
