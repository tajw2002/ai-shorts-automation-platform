import Link from 'next/link';
import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState, ErrorNote, StatusBadge } from '@/components/ui';
import { formatDateTime, formatRelative, truncate } from '@/lib/format';
import type { JobStatus, JobType } from '@shorts/contracts';

export const metadata = { title: 'Job queue · AI Shorts' };
export const dynamic = 'force-dynamic';

interface JobRow {
  id: string;
  type: JobType;
  status: JobStatus;
  videoId: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
}

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams({ pageSize: '50' });
  if (params.status) query.set('status', params.status);

  const { data, error } = await apiFetchSafe<{ items: JobRow[]; total: number }>(
    `/jobs?${query.toString()}`,
    { items: [], total: 0 },
  );

  return (
    <>
      <PageHeader
        title="Job queue"
        description="Every unit of background work, with its retry budget and last error."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/queue" className={`btn ${params.status ? 'btn-ghost' : 'btn-primary'}`}>
          All
        </Link>
        {['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER'].map((status) => (
          <Link
            key={status}
            href={`/queue?status=${status}`}
            className={`btn ${params.status === status ? 'btn-primary' : 'btn-ghost'}`}
          >
            {status.replace(/_/g, ' ').toLowerCase()}
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
          <EmptyState title="No jobs" description="Background work appears here as it is queued." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Video</th>
                  <th>Created</th>
                  <th>Finished</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((job) => (
                  <tr key={job.id}>
                    <td className="font-mono text-xs">{job.type}</td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="tabular-nums">
                      <span
                        className={
                          job.attempts >= job.maxAttempts ? 'text-[var(--color-error)]' : ''
                        }
                      >
                        {job.attempts}/{job.maxAttempts}
                      </span>
                    </td>
                    <td>
                      {job.videoId ? (
                        <Link href={`/videos/${job.videoId}`} className="text-xs hover:underline">
                          {job.videoId.slice(0, 8)}…
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="text-xs text-[var(--color-text-muted)]">
                      {formatRelative(job.createdAt)}
                    </td>
                    <td className="text-xs text-[var(--color-text-muted)]">
                      {job.finishedAt ? formatDateTime(job.finishedAt) : '—'}
                    </td>
                    <td className="max-w-xs text-xs text-[var(--color-error)]">
                      {job.errorMessage ? truncate(job.errorMessage, 90) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
