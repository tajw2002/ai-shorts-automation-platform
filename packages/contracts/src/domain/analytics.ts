/** Metrics derived from two or more snapshots. */
export interface DerivedMetrics {
  viewsPerHour: number;
  viewsPerDay: number;
  /** likes / views, 0 when views is 0. */
  likeRate: number;
  /** comments / views, 0 when views is 0. */
  commentRate: number;
  /**
   * Weighted 0-100 score. Combines velocity and engagement so a two-day-old
   * video is comparable with a two-month-old one.
   */
  performanceScore: number;
  hoursSincePublish: number;
}

/** Output of the AI performance analysis — patterns, never copies. */
export interface PerformanceInsight {
  /** e.g. `hook`, `duration`, `posting_hour`, `character_mix`. */
  dimension: string;
  observation: string;
  /** Actionable guidance fed back into idea generation. */
  recommendation: string;
  /** 0 → 1. How strongly the data supports this. */
  confidence: number;
  /** Ids of the videos the observation is drawn from. */
  sampleVideoIds: string[];
}

export interface PerformanceAnalysisResult {
  insights: PerformanceInsight[];
  sampleSize: number;
  analyzedAt: string;
  summary: string;
}
