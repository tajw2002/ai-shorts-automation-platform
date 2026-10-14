import { type CostCategory } from '../enums';

/**
 * Money is stored and transported as integer **micro-USD** to avoid floating
 * point drift when thousands of small provider charges are summed.
 */
export const MICRO_USD_PER_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICRO_USD_PER_USD);
}

export function microsToUsd(micros: number): number {
  return micros / MICRO_USD_PER_USD;
}

export interface CostEntry {
  category: CostCategory;
  provider: string;
  model: string | null;
  operation: string;
  /** Tokens, seconds of video, characters of speech — unit depends on operation. */
  units: number;
  unitLabel: string;
  requests: number;
  estimatedMicros: number;
  /** Populated when the provider reports real billing; otherwise null. */
  actualMicros: number | null;
}

export interface CostSummary {
  todayMicros: number;
  monthMicros: number;
  dailyLimitMicros: number;
  monthlyLimitMicros: number;
  costPerVideoMicros: number;
  costPerPublishedVideoMicros: number;
  videosGenerated: number;
  videosPublished: number;
}

export interface BudgetDecision {
  allowed: boolean;
  /** Populated when `allowed` is false. */
  reason: string | null;
  /** True when spend has crossed the warning threshold but not the hard limit. */
  warning: boolean;
  remainingDailyMicros: number;
  remainingMonthlyMicros: number;
}
