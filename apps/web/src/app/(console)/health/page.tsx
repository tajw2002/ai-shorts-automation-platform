import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, ErrorNote, toneForStatus } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import type { SystemHealthReport } from '@shorts/contracts';

export const metadata = { title: 'System health · AI Shorts' };
export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  const { data, error } = await apiFetchSafe<SystemHealthReport>('/system/health', {
    status: 'ERROR',
    components: [],
    version: 'unknown',
    uptimeSeconds: 0,
    checkedAt: new Date().toISOString(),
  });

  return (
    <>
      <PageHeader
        title="System health"
        description="Live probe of every component the platform depends on."
        actions={<Badge tone={toneForStatus(data.status)}>{data.status}</Badge>}
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <Card
        description={`Version ${data.version} · up ${Math.floor(data.uptimeSeconds / 60)} min · checked ${formatDateTime(data.checkedAt)}`}
      >
        <ul className="divide-y">
          {data.components.map((component) => (
            <li key={component.name} className="flex flex-wrap items-center gap-3 py-2.5">
              <Badge tone={toneForStatus(component.status)}>{component.status}</Badge>
              <span className="text-sm font-medium">{component.name}</span>
              <span className="min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
                {component.message}
              </span>
              {component.latencyMs !== null && (
                <span className="text-xs tabular-nums text-[var(--color-text-faint)]">
                  {component.latencyMs} ms
                </span>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
