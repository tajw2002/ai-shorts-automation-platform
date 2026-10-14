import { Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
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
 * Anthropic adapter.
 *
 * Uses the SDK's structured-output path (`messages.parse` with `zodOutputFormat`),
 * so a response either satisfies the contract schema or throws. There is no
 * hand-rolled JSON extraction and no "best effort" parsing of prose — an
 * unparseable response is a failure the job runner can retry, not a half-valid
 * object that corrupts the database.
 */
@Injectable()
export class AnthropicLLMProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;

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
      // A one-token round trip is the cheapest honest liveness signal.
      await this.sdk().messages.countTokens({
        model: this.config.llm.model,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return okHealth(`Model ${this.config.llm.model} reachable`, Date.now() - startedAt);
    } catch (error) {
      return errorHealth(this.describeFailure(error));
    }
  }

  describe(): Record<string, string | number | boolean | null> {
    return {
      model: this.config.llm.model,
      maxOutputTokens: this.config.llm.maxOutputTokens,
      timeoutMs: this.config.llm.timeoutMs,
      inputCostPerMTok: this.config.llm.inputCostPerMTok,
      outputCostPerMTok: this.config.llm.outputCostPerMTok,
    };
  }

  async generateIdeas(input: GenerateIdeasInput): Promise<ProviderResult<ContentIdeaDraft[]>> {
    const result = await this.parse(
      prompts.buildIdeasSystemPrompt(),
      prompts.buildIdeasUserPrompt(input),
      prompts.ideasResponseSchema,
      'generateIdeas',
    );
    return { ...result, data: result.data.ideas };
  }

  async generateScript(input: GenerateScriptInput): Promise<ProviderResult<ScriptDraft>> {
    return this.parse(
      prompts.buildScriptSystemPrompt(),
      prompts.buildScriptUserPrompt(input),
      prompts.scriptResponseSchema,
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
        evaluators: ['anthropic'],
        evaluatedAt: new Date().toISOString(),
      },
    };
  }

  // -- internals ------------------------------------------------------------

  private sdk(): Anthropic {
    if (!this.config.llm.apiKey) {
      throw new ProviderNotConfiguredError('LLM', this.name, this.missingConfiguration());
    }
    this.client ??= new Anthropic({
      apiKey: this.config.llm.apiKey,
      // The SDK's own timeout; the resilience layer adds the retry policy on top.
      timeout: this.config.llm.timeoutMs,
      maxRetries: 0,
    });
    return this.client;
  }

  private async parse<T>(
    system: string,
    userPrompt: string,
    schema: ZodType<T>,
    operation: string,
  ): Promise<ProviderResult<T>> {
    try {
      const message = await this.sdk().messages.parse({
        model: this.config.llm.model,
        max_tokens: this.config.llm.maxOutputTokens,
        system,
        messages: [{ role: 'user', content: userPrompt }],
        output_config: { format: zodOutputFormat(schema) },
      });

      if (message.stop_reason === 'refusal') {
        throw new ProviderError({
          provider: this.name,
          message: `${operation}: the model declined the request (${
            message.stop_details?.category ?? 'unspecified'
          }).`,
          retryable: false,
        });
      }

      if (message.parsed_output === null || message.parsed_output === undefined) {
        throw new ProviderError({
          provider: this.name,
          message: `${operation}: the response did not satisfy the expected schema.`,
          retryable: true,
          details: { stopReason: message.stop_reason },
        });
      }

      const inputTokens = message.usage.input_tokens;
      const outputTokens = message.usage.output_tokens;

      return {
        data: message.parsed_output as T,
        model: message.model,
        correlationId: message.id,
        usage: {
          units: inputTokens + outputTokens,
          unitLabel: 'tokens',
          inputTokens,
          outputTokens,
          actualCostMicros: this.priceTokens(inputTokens, outputTokens),
        },
      };
    } catch (error) {
      throw this.toProviderError(error, operation);
    }
  }

  /** Token pricing comes from configuration so a price change is not a code change. */
  private priceTokens(inputTokens: number, outputTokens: number): number {
    const inputUsd = (inputTokens / 1_000_000) * this.config.llm.inputCostPerMTok;
    const outputUsd = (outputTokens / 1_000_000) * this.config.llm.outputCostPerMTok;
    return usdToMicros(inputUsd + outputUsd);
  }

  private toProviderError(error: unknown, operation: string): Error {
    if (error instanceof ProviderError) return error;

    // Retryability follows the SDK's typed error classes rather than string
    // matching, so a new error message upstream cannot silently change behaviour.
    if (error instanceof Anthropic.RateLimitError) {
      return new ProviderError({
        provider: this.name,
        message: `${operation}: rate limited.`,
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new ProviderError({
        provider: this.name,
        message: `${operation}: connection failure.`,
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof Anthropic.AuthenticationError) {
      return new ProviderError({
        provider: this.name,
        message: `${operation}: authentication failed. Check LLM_API_KEY.`,
        retryable: false,
        cause: error,
      });
    }
    if (error instanceof Anthropic.APIError) {
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

  private describeFailure(error: unknown): string {
    if (error instanceof Anthropic.APIError) {
      return `Anthropic API error ${error.status ?? 'unknown'}`;
    }
    return error instanceof Error ? error.message : 'Unknown Anthropic failure';
  }
}
