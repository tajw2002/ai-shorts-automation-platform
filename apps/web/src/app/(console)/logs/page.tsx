import Link from 'next/link';
import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, EmptyState, ErrorNote, toneForStatus } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

export const metadata = { title: 'Logs · AI Shorts' };
export const dynamic = 'force-dynamic';

interface LogRow {
  id: string;
  level: string;
  service: string;
  message: string;
  error: string | null;
  videoId: string | null;
  jobId: string | null;
  createdAt: string;
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ level?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams({ pageSize: '100' });
  if (params.level) query.set('level', params.level);

  const { data, error } = await apiFetchSafe<{ items: LogRow[]; total: number }>(
    `/system/logs?${query.toString()}`,
    { items: [], total: 0 },
  );

  return (
    <>
      <PageHeader
        title="Logs"
        description="Application events worth an operator's attention. Secrets are redacted before they are written."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/logs" className={`btn ${params.level ? 'btn-ghost' : 'btn-primary'}`}>
          All
        </Link>
        {['INFO', 'WARN', 'ERROR', 'FATAL'].map((level) => (
          <Link
            key={level}
            href={`/logs?level=${level}`}
            className={`btn ${params.level === level ? 'btn-primary' : 'btn-ghost'}`}
          >
            {level.toLowerCase()}
          </Link>
        ))}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <Card>
        {data.items.length === 0 ? (
          <EmptyState title="No log entries" />
        ) : (
          <ul className="divide-y">
            {data.items.map((entry) => (
              <li key={entry.id} className="py-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Badge tone={toneForStatus(entry.level)}>{entry.level}</Badge>
                  <span className="font-mono text-xs text-[var(--color-text-faint)]">
                    {formatDateTime(entry.createdAt)}
                  </span>
                  <span className="text-xs font-medium text-[var(--color-text-muted)]">
                    {entry.service}
                  </span>
                  <span className="min-w-0 flex-1 text-sm">{entry.message}</span>
                  {entry.videoId && (
                    <Link href={`/videos/${entry.videoId}`} className="text-xs hover:underline">
                      video →
                    </Link>
                  )}
                </div>
                {entry.error && (
                  <pre className="mt-1 overflow-x-auto rounded bg-[var(--color-surface)] p-2 font-mono text-xs text-[var(--color-error)]">
                    {entry.error}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
