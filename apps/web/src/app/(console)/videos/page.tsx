import Link from 'next/link';
import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState, ErrorNote, StatusBadge } from '@/components/ui';
import { formatDuration, formatNumber, formatRelative, truncate } from '@/lib/format';
import type { Paginated, VideoSummary } from '@shorts/contracts';

export const metadata = { title: 'Videos · AI Shorts' };
export const dynamic = 'force-dynamic';

const STATUS_FILTERS = [
  'READY_FOR_REVIEW',
  'APPROVED',
  'GENERATING',
  'QUEUED',
  'PUBLISHED',
  'FAILED',
] as const;

export default async function VideosPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const query = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (params.status) query.set('status', params.status);

  const { data, error } = await apiFetchSafe<Paginated<VideoSummary>>(
    `/videos?${query.toString()}`,
    { items: [], page, pageSize: 25, total: 0, totalPages: 1 },
  );

  return (
    <>
      <PageHeader title="Videos" description="Every video the platform has produced." />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/videos" className={`btn ${params.status ? 'btn-ghost' : 'btn-primary'}`}>
          All
        </Link>
        {STATUS_FILTERS.map((status) => (
          <Link
            key={status}
            href={`/videos?status=${status}`}
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
          <EmptyState
            title="No videos here"
            description="Generate an idea, then produce a video from it."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Length</th>
                  <th>Channel</th>
                  <th className="text-right">Views</th>
                  <th>Created</th>
                  <th>Published</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((video) => (
                  <tr key={video.id}>
                    <td>
                      <Link href={`/videos/${video.id}`} className="hover:underline">
                        {truncate(video.title ?? 'Untitled', 44)}
                      </Link>
                      {video.lastError && (
                        <p className="mt-0.5 text-xs text-[var(--color-error)]">
                          {truncate(video.lastError, 70)}
                        </p>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={video.status} />
                    </td>
                    <td className="tabular-nums">{formatDuration(video.durationSeconds)}</td>
                    <td className="text-[var(--color-text-muted)]">{video.channelName ?? '—'}</td>
                    <td className="text-right tabular-nums">{formatNumber(video.views)}</td>
                    <td className="text-[var(--color-text-muted)]">
                      {formatRelative(video.createdAt)}
                    </td>
                    <td className="text-[var(--color-text-muted)]">
                      {video.youtubeUrl ? (
                        <a
                          href={video.youtubeUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:underline"
                        >
                          {formatRelative(video.publishedAt)} ↗
                        </a>
                      ) : (
                        formatRelative(video.publishedAt)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.totalPages > 1 && (
          <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
            <span className="text-[var(--color-text-muted)]">
              Page {data.page} of {data.totalPages} · {data.total} videos
            </span>
            <div className="flex gap-2">
              {page > 1 && (
                <Link
                  href={`/videos?${new URLSearchParams({ ...(params.status ? { status: params.status } : {}), page: String(page - 1) })}`}
                  className="btn btn-ghost"
                >
                  Previous
                </Link>
              )}
              {page < data.totalPages && (
                <Link
                  href={`/videos?${new URLSearchParams({ ...(params.status ? { status: params.status } : {}), page: String(page + 1) })}`}
                  className="btn btn-ghost"
                >
                  Next
                </Link>
              )}
            </div>
          </nav>
        )}
      </Card>
    </>
  );
}
