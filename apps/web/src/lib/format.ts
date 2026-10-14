/** Presentation helpers. Pure, so they can be used from server and client alike. */

/** Money arrives as integer micro-USD; never render raw micros to a person. */
export function formatUsd(micros: number): string {
  const usd = micros / 1_000_000;
  // Sub-cent amounts are common per generation step and would all render as
  // "$0.00", which reads as free rather than small.
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(usd);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: value >= 10_000 ? 'compact' : 'standard',
  }).format(value);
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return '—';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder}s`;
}

/** Absolute timestamp in the operator's own locale and zone. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** "3 minutes ago" — the right unit for a queue, where recency is what matters. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = date.getTime() - Date.now();
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const divisions: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60_000],
    ['minute', 3_600_000],
    ['hour', 86_400_000],
    ['day', 604_800_000],
    ['week', 2_629_800_000],
    ['month', 31_557_600_000],
  ];

  for (const [unit, limit] of divisions) {
    if (Math.abs(diffMs) < limit) {
      const divisor =
        unit === 'second'
          ? 1000
          : unit === 'minute'
            ? 60_000
            : unit === 'hour'
              ? 3_600_000
              : unit === 'day'
                ? 86_400_000
                : unit === 'week'
                  ? 604_800_000
                  : 2_629_800_000;
      return formatter.format(Math.round(diffMs / divisor), unit);
    }
  }
  return formatter.format(Math.round(diffMs / 31_557_600_000), 'year');
}

/** Truncates for a table cell without splitting a word awkwardly. */
export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/**
 * Rewrites an API-relative asset URL so the browser can fetch it.
 *
 * The local storage provider has no signing mechanism, so it returns its own
 * path (`/api/v1/assets/content?key=…`). The browser only ever talks to this
 * origin's proxy, so that prefix has to be swapped. Absolute URLs — what the GCS
 * provider returns, already signed — are passed through untouched.
 */
export function toBrowserAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api/v1/')) return `/api/proxy/${url.slice('/api/v1/'.length)}`;
  return url;
}
