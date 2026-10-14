import { type ReactNode } from 'react';

/**
 * Shared presentational primitives.
 *
 * Status colour is centralised here so a state means the same thing on every
 * page — a `FAILED` badge is the same red in the queue, the video list and the
 * detail view, which is what lets an operator scan rather than read.
 */

type StatusTone = 'neutral' | 'ok' | 'warn' | 'error' | 'info' | 'accent';

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral:
    'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] border-[var(--color-border)]',
  ok: 'bg-[color-mix(in_oklch,var(--color-ok)_18%,transparent)] text-[var(--color-ok)] border-[color-mix(in_oklch,var(--color-ok)_40%,transparent)]',
  warn: 'bg-[color-mix(in_oklch,var(--color-warn)_18%,transparent)] text-[var(--color-warn)] border-[color-mix(in_oklch,var(--color-warn)_40%,transparent)]',
  error:
    'bg-[color-mix(in_oklch,var(--color-error)_18%,transparent)] text-[var(--color-error)] border-[color-mix(in_oklch,var(--color-error)_40%,transparent)]',
  info: 'bg-[color-mix(in_oklch,var(--color-info)_18%,transparent)] text-[var(--color-info)] border-[color-mix(in_oklch,var(--color-info)_40%,transparent)]',
  accent:
    'bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[var(--color-accent-strong)] border-[color-mix(in_oklch,var(--color-accent)_40%,transparent)]',
};

/** Maps every video/job/health state onto a tone. */
export function toneForStatus(status: string): StatusTone {
  switch (status) {
    case 'PUBLISHED':
    case 'SUCCEEDED':
    case 'COMPLETED':
    case 'OK':
    case 'PASS':
    case 'ALLOW':
    case 'ACTIVE':
      return 'ok';
    case 'FAILED':
    case 'DEAD_LETTER':
    case 'REJECTED':
    case 'ERROR':
    case 'BLOCK':
      return 'error';
    case 'READY_FOR_REVIEW':
    case 'WARNING':
    case 'WARN':
    case 'REVIEW':
    case 'PAUSED':
      return 'warn';
    case 'APPROVED':
    case 'QUEUED':
    case 'UPLOADING':
    case 'RUNNING':
    case 'GENERATING':
    case 'ASSEMBLING':
      return 'info';
    case 'CANCELLED':
    case 'DISABLED':
    case 'ARCHIVED':
      return 'neutral';
    default:
      return 'accent';
  }
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: StatusTone }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={toneForStatus(status)}>{status.replace(/_/g, ' ').toLowerCase()}</Badge>;
}

export function Card({
  title,
  description,
  actions,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{description}</p>
            )}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: StatusTone;
}) {
  const valueColor =
    tone === 'error'
      ? 'text-[var(--color-error)]'
      : tone === 'warn'
        ? 'text-[var(--color-warn)]'
        : tone === 'ok'
          ? 'text-[var(--color-ok)]'
          : 'text-[var(--color-text)]';

  return (
    <div className="card">
      <p className="text-xs font-medium tracking-wide text-[var(--color-text-muted)] uppercase">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">{hint}</p>}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-10 text-center">
      <p className="text-sm font-medium text-[var(--color-text-muted)]">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-text-faint)]">
          {description}
        </p>
      )}
    </div>
  );
}

/** Surfaces a panel-level failure without taking the whole page down. */
export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-[color-mix(in_oklch,var(--color-error)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-error)_12%,transparent)] px-3 py-2 text-xs text-[var(--color-error)]">
      {message}
    </div>
  );
}

/** A labelled meter, used for quota and budget consumption. */
export function Meter({
  label,
  used,
  limit,
  format = (value: number) => String(value),
}: {
  label: string;
  used: number;
  limit: number;
  format?: (value: number) => string;
}) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const tone = ratio >= 1 ? 'error' : ratio >= 0.8 ? 'warn' : 'ok';
  const barColor =
    tone === 'error'
      ? 'var(--color-error)'
      : tone === 'warn'
        ? 'var(--color-warn)'
        : 'var(--color-ok)';

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-[var(--color-text-muted)]">{label}</span>
        <span className="tabular-nums">
          {format(used)}
          <span className="text-[var(--color-text-faint)]">
            {' '}
            / {limit > 0 ? format(limit) : '∞'}
          </span>
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-hover)]"
        role="meter"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={label}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${ratio * 100}%`, background: barColor }}
        />
      </div>
    </div>
  );
}
