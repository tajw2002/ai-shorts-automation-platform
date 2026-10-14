import { Badge } from './ui';

/**
 * The always-visible state of the system.
 *
 * A paused or dry-run platform must be impossible to mistake for a running one —
 * the most expensive failure mode here is an operator waiting for videos that
 * were never going to be produced.
 */
export function SystemBanner({
  operational,
}: {
  operational: {
    emergencyStop: boolean;
    generationPaused: boolean;
    uploadsPaused: boolean;
    dryRun: boolean;
    autoPublish: boolean;
    requireApproval: boolean;
  };
}) {
  if (operational.emergencyStop) {
    return (
      <div
        role="alert"
        className="border-b border-[color-mix(in_oklch,var(--color-error)_50%,transparent)] bg-[color-mix(in_oklch,var(--color-error)_16%,transparent)] px-4 py-2 text-sm font-semibold text-[var(--color-error)]"
      >
        SYSTEM PAUSED — the emergency stop is active. No content is generated and nothing is
        published.
      </div>
    );
  }

  const notices: Array<{ label: string; tone: 'warn' | 'info' | 'neutral' }> = [];
  if (operational.generationPaused) notices.push({ label: 'Generation paused', tone: 'warn' });
  if (operational.uploadsPaused) notices.push({ label: 'Uploads paused', tone: 'warn' });
  if (operational.dryRun) notices.push({ label: 'Dry run — nothing is uploaded', tone: 'info' });
  if (!operational.autoPublish) notices.push({ label: 'Auto-publish off', tone: 'neutral' });
  if (operational.requireApproval) notices.push({ label: 'Approval required', tone: 'neutral' });

  if (notices.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-[var(--color-surface-raised)] px-4 py-2">
      {notices.map((notice) => (
        <Badge key={notice.label} tone={notice.tone}>
          {notice.label}
        </Badge>
      ))}
    </div>
  );
}
