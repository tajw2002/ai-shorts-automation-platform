import Link from 'next/link';
import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState, ErrorNote } from '@/components/ui';
import { ReviewActions } from '@/components/review-actions';
import { formatDuration, formatRelative } from '@/lib/format';

export const metadata = { title: 'Review queue · AI Shorts' };
export const dynamic = 'force-dynamic';

interface QueueItem {
  id: string;
  title: string | null;
  durationSeconds: number | null;
  createdAt: string;
  channel: { title: string } | null;
}

export default async function ReviewPage() {
  const { data, error } = await apiFetchSafe<QueueItem[]>('/videos/review-queue', []);

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Videos that passed quality control and are waiting for a human decision."
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {data.length === 0 ? (
        <EmptyState
          title="Nothing to review"
          description="Videos appear here once they have been rendered and have passed quality control."
        />
      ) : (
        <div className="space-y-3">
          {data.map((video) => (
            <Card key={video.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <Link href={`/videos/${video.id}`} className="font-medium hover:underline">
                    {video.title ?? 'Untitled'}
                  </Link>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    {formatDuration(video.durationSeconds)} · {video.channel?.title ?? 'no channel'}{' '}
                    · created {formatRelative(video.createdAt)}
                  </p>
                </div>
                <ReviewActions videoId={video.id} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
