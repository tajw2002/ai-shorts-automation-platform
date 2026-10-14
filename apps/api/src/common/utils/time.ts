/**
 * Timezone-aware date helpers built on the platform's own tz database.
 *
 * Scheduling is expressed in an operator's wall-clock time ("post at 09:00 Berlin
 * time"), which is not a fixed UTC offset — it shifts twice a year. Rather than
 * pull in a date library, we use `Intl.DateTimeFormat`, which is backed by ICU and
 * therefore always current with the tz database shipped by the runtime.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, matching ScheduleSlot.dayOfWeek. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Breaks an instant down into wall-clock fields in the given zone. */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0';

  return {
    year: Number(lookup('year')),
    month: Number(lookup('month')),
    day: Number(lookup('day')),
    hour: Number(lookup('hour')),
    minute: Number(lookup('minute')),
    second: Number(lookup('second')),
    weekday: WEEKDAY_INDEX[lookup('weekday')] ?? 0,
  };
}

/**
 * Converts a wall-clock time in `timeZone` to the corresponding UTC instant.
 *
 * The offset depends on the instant we are solving for, so a naive fixed-point
 * iteration oscillates inside a DST transition. Instead we bracket the target:
 * the offsets one day either side are guaranteed to span any transition, giving
 * at most three candidate instants. Then:
 *
 *  - **Normal day** — one candidate maps back to the requested wall time.
 *  - **Fall-back overlap** (02:30 happens twice) — two candidates are valid and
 *    the *earlier* is chosen, so a scheduled slot fires once, at its first
 *    occurrence.
 *  - **Spring-forward gap** (02:30 never happens) — no candidate is valid, so the
 *    instant just after the transition is chosen. A slot in the lost hour still
 *    runs rather than being silently skipped for the day.
 */
export function zonedWallTimeToUtc(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second?: number;
  },
  timeZone: string,
): Date {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  );

  /** Milliseconds the zone is ahead of UTC at a given instant. */
  const offsetAt = (timestamp: number): number => {
    const zoned = getZonedParts(new Date(timestamp), timeZone);
    return (
      Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second) -
      timestamp
    );
  };

  /** Does this instant actually render as the wall time we asked for? */
  const rendersAsTarget = (timestamp: number): boolean => {
    const zoned = getZonedParts(new Date(timestamp), timeZone);
    return (
      Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second) ===
      target
    );
  };

  const DAY_MS = 86_400_000;
  const candidates = [
    ...new Set([
      target - offsetAt(target - DAY_MS),
      target - offsetAt(target),
      target - offsetAt(target + DAY_MS),
    ]),
  ];

  const valid = candidates.filter(rendersAsTarget).sort((a, b) => a - b);
  if (valid.length > 0) return new Date(valid[0] as number);

  // Gap: the requested wall time does not exist. Land just after the transition.
  return new Date(Math.max(...candidates));
}

/** `YYYY-MM-DD` in the given zone. The key daily quotas are counted against. */
export function dayKey(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `YYYY-MM` in the given zone. */
export function monthKey(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

/** Midnight local to the zone, as a UTC instant. */
export function startOfDayInZone(date: Date, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  return zonedWallTimeToUtc(
    { year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 },
    timeZone,
  );
}

/** First day of the month, local to the zone, as a UTC instant. */
export function startOfMonthInZone(date: Date, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  return zonedWallTimeToUtc({ year: p.year, month: p.month, day: 1, hour: 0, minute: 0 }, timeZone);
}

export interface RecurringSlot {
  /** 0 = Sunday … 6 = Saturday. `null` means every day. */
  dayOfWeek: number | null;
  hour: number;
  minute: number;
}

/**
 * The next instant at or after `from` that matches one of the slots.
 *
 * Scans forward day by day for at most 14 days — enough to cover any weekly
 * pattern, and bounded so a malformed slot cannot spin the loop.
 */
export function nextSlotOccurrence(
  slots: readonly RecurringSlot[],
  timeZone: string,
  from: Date = new Date(),
): Date | null {
  if (slots.length === 0) return null;

  const candidates: Date[] = [];
  const base = getZonedParts(from, timeZone);

  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    // Step through calendar days using a UTC anchor at local noon, which is far
    // enough from any DST boundary that adding whole days never skips a date.
    const anchor = new Date(Date.UTC(base.year, base.month - 1, base.day + dayOffset, 12));
    const anchorParts = getZonedParts(anchor, timeZone);

    for (const slot of slots) {
      if (slot.dayOfWeek !== null && slot.dayOfWeek !== anchorParts.weekday) continue;
      const occurrence = zonedWallTimeToUtc(
        {
          year: anchorParts.year,
          month: anchorParts.month,
          day: anchorParts.day,
          hour: slot.hour,
          minute: slot.minute,
        },
        timeZone,
      );
      if (occurrence.getTime() >= from.getTime()) candidates.push(occurrence);
    }

    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, current) => (current < earliest ? current : earliest));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

/** Human-friendly duration for log lines and the dashboard. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
