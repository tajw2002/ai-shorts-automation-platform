import { Injectable } from '@nestjs/common';
import { type CostCategory } from '@shorts/contracts';
import { BudgetExceededError } from '@/common/errors';
import { type ProviderResult } from '@/providers/provider.types';
import { CostService } from './cost.service';

export interface MeterDescriptor {
  category: CostCategory;
  provider: string;
  model?: string | null;
  /** e.g. `generateScript`, `generateVideo`. Appears in the cost breakdown. */
  operation: string;
  /** Pre-call estimate in micro-USD. Checked against the budget before spending. */
  estimatedMicros: number;
  /** Fallback unit count when the provider does not report usage. */
  fallbackUnits?: number;
  fallbackUnitLabel?: string;
  videoId?: string | null;
  jobId?: string | null;
}

/**
 * Wraps a billable provider call with budget enforcement and cost recording.
 *
 * Every paid call in the platform goes through here. Keeping it in one place is
 * what makes the guarantee auditable: there is no second path that spends money
 * without being counted, and the budget is always checked *before* the call
 * rather than after.
 */
@Injectable()
export class MeteredExecutor {
  constructor(private readonly cost: CostService) {}

  async run<T>(
    descriptor: MeterDescriptor,
    call: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    await this.assertWithinBudget(descriptor);

    const result = await call();

    await this.cost.record({
      category: descriptor.category,
      provider: descriptor.provider,
      model: result.model ?? descriptor.model ?? null,
      operation: descriptor.operation,
      units: result.usage.units || (descriptor.fallbackUnits ?? 0),
      unitLabel: result.usage.unitLabel || (descriptor.fallbackUnitLabel ?? 'units'),
      requests: 1,
      estimatedMicros: descriptor.estimatedMicros,
      actualMicros: result.usage.actualCostMicros ?? null,
      videoId: descriptor.videoId ?? null,
      jobId: descriptor.jobId ?? null,
    });

    return result;
  }

  /**
   * For calls that do not return a `ProviderResult` — video generation, where
   * the spend is committed at submit time and the units are known up front.
   */
  async runRaw<T>(descriptor: MeterDescriptor, call: () => Promise<T>): Promise<T> {
    await this.assertWithinBudget(descriptor);

    const result = await call();

    await this.cost.record({
      category: descriptor.category,
      provider: descriptor.provider,
      model: descriptor.model ?? null,
      operation: descriptor.operation,
      units: descriptor.fallbackUnits ?? 0,
      unitLabel: descriptor.fallbackUnitLabel ?? 'units',
      requests: 1,
      estimatedMicros: descriptor.estimatedMicros,
      actualMicros: null,
      videoId: descriptor.videoId ?? null,
      jobId: descriptor.jobId ?? null,
    });

    return result;
  }

  private async assertWithinBudget(descriptor: MeterDescriptor): Promise<void> {
    const decision = await this.cost.enforceBudget(
      descriptor.estimatedMicros,
      descriptor.operation,
    );
    if (!decision.allowed) {
      throw new BudgetExceededError(decision.reason ?? 'Cost limit reached.', {
        operation: descriptor.operation,
        provider: descriptor.provider,
      });
    }
  }
}
