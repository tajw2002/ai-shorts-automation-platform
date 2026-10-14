import { type DerivedMetrics } from '@shorts/contracts';

/**
 * Derived analytics.
 *
 * Pure functions over snapshot data. Kept separate from the service so the
 * scoring model — the part most likely to be tuned — can be reasoned about and
 * tested without a database.
 */

export interface SnapshotLike {
  views: number;
  likes: number;
  comments: number;
  capturedAt: Date;
}

export function computeDerivedMetrics(
  latest: SnapshotLike,
  publishedAt: Date,
  now: Date = new Date(),
): DerivedMetrics {
  // A video published seconds ago would otherwise divide by ~0 and report
  // millions of views per hour.
  const hoursSincePublish = Math.max(0.5, (now.getTime() - publishedAt.getTime()) / 3_600_000);

  const viewsPerHour = latest.views / hoursSincePublish;
  const likeRate = latest.views > 0 ? latest.likes / latest.views : 0;
  const commentRate = latest.views > 0 ? latest.comments / latest.views : 0;

  return {
    viewsPerHour: round2(viewsPerHour),
    viewsPerDay: round2(viewsPerHour * 24),
    likeRate: round4(likeRate),
    commentRate: round4(commentRate),
    performanceScore: computePerformanceScore({
      viewsPerHour,
      likeRate,
      commentRate,
      hoursSincePublish,
    }),
    hoursSincePublish: round2(hoursSincePublish),
  };
}

/**
 * A 0-100 score blending reach velocity with engagement quality.
 *
 * Velocity rather than raw views so a two-day-old video is comparable with a
 * two-month-old one, and log-scaled because view counts span orders of magnitude
 * — the difference between 10 and 100 views/hour matters far more than between
 * 10,000 and 10,090.
 *
 * Engagement rates are capped at generous ceilings (10% likes, 2% comments) so a
 * video with three views and one like cannot score as a runaway success.
 */
export function computePerformanceScore(input: {
  viewsPerHour: number;
  likeRate: number;
  commentRate: number;
  hoursSincePublish: number;
}): number {
  const VELOCITY_WEIGHT = 0.6;
  const LIKE_WEIGHT = 0.25;
  const COMMENT_WEIGHT = 0.15;

  // log10(1 + v/h) / log10(1001) maps 0 → 0 and 1000 views/hour → 1.
  const velocityScore = Math.min(1, Math.log10(1 + input.viewsPerHour) / Math.log10(1001));
  const likeScore = Math.min(1, input.likeRate / 0.1);
  const commentScore = Math.min(1, input.commentRate / 0.02);

  const raw =
    velocityScore * VELOCITY_WEIGHT + likeScore * LIKE_WEIGHT + commentScore * COMMENT_WEIGHT;

  // Below a few hours the sample is too thin to trust; damp the score rather than
  // letting a brand-new video top the leaderboard.
  const confidence = Math.min(1, input.hoursSincePublish / 6);

  return round2(raw * confidence * 100);
}

/** Growth between two consecutive snapshots, for the trend chart. */
export function computeDelta(
  previous: SnapshotLike,
  current: SnapshotLike,
): { views: number; likes: number; comments: number; hours: number } {
  const hours = Math.max(
    0.01,
    (current.capturedAt.getTime() - previous.capturedAt.getTime()) / 3_600_000,
  );
  return {
    // Clamped at zero: YouTube's counts can be revised downward after spam
    // filtering, and a negative "growth" is noise rather than signal.
    views: Math.max(0, current.views - previous.views),
    likes: Math.max(0, current.likes - previous.likes),
    comments: Math.max(0, current.comments - previous.comments),
    hours: round2(hours),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
