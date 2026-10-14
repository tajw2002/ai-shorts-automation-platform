import Link from 'next/link';
import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState, ErrorNote, Meter, Stat, StatusBadge } from '@/components/ui';
import { formatDateTime, formatNumber, formatRelative, formatUsd, truncate } from '@/lib/format';
import type { DashboardStats } from '@shorts/contracts';

export const metadata = { title: 'Dashboard · AI Shorts' };
export const dynamic = 'force-dynamic';

const EMPTY: DashboardStats = {
  videosGenerated: 0,
  videosPublished: 0,
  videosInQueue: 0,
  videosAwaitingReview: 0,
  failedJobs24h: 0,
  uploadsToday: 0,
  uploadsRemainingToday: 0,
  totalViews: 0,
  totalLikes: 0,
  totalComments: 0,
  averageViewDurationSeconds: null,
  cost: {
    todayMicros: 0,
    monthMicros: 0,
    dailyLimitMicros: 0,
    monthlyLimitMicros: 0,
    costPerVideoMicros: 0,
    costPerPublishedVideoMicros: 0,
    videosGenerated: 0,
    videosPublished: 0,
  },
  operational: {
    emergencyStop: false,
    generationPaused: false,
    uploadsPaused: false,
    autoPublish: false,
    requireApproval: true,
    dryRun: true,
    approvalMode: 'MANUAL',
  },
  topVideos: [],
  recentErrors: [],
};

export default async function DashboardPage() {
  const { data: stats, error } = await apiFetchSafe<DashboardStats>('/dashboard', EMPTY);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Production, publishing and spend at a glance."
        actions={
          stats.videosAwaitingReview > 0 ? (
            <Link href="/review" className="btn btn-primary">
              Review {stats.videosAwaitingReview} video{stats.videosAwaitingReview === 1 ? '' : 's'}
            </Link>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Generated"
          value={formatNumber(stats.videosGenerated)}
          hint="videos produced"
        />
        <Stat
          label="Published"
          value={formatNumber(stats.videosPublished)}
          hint="live on YouTube"
        />
        <Stat
          label="In pipeline"
          value={formatNumber(stats.videosInQueue)}
          hint="being produced or uploaded"
          tone={stats.videosInQueue > 0 ? 'ok' : 'neutral'}
        />
        <Stat
          label="Awaiting review"
          value={formatNumber(stats.videosAwaitingReview)}
          hint="need a decision"
          tone={stats.videosAwaitingReview > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Views" value={formatNumber(stats.totalViews)} />
        <Stat label="Likes" value={formatNumber(stats.totalLikes)} />
        <Stat label="Comments" value={formatNumber(stats.totalComments)} />
        <Stat
          label="Failed jobs"
          value={formatNumber(stats.failedJobs24h)}
          hint="last 24 hours"
          tone={stats.failedJobs24h > 0 ? 'error' : 'neutral'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title="Quota & budget"
          description="Hard limits enforced before every upload and paid call."
        >
          <div className="space-y-4">
            <Meter
              label="Uploads today"
              used={stats.uploadsToday}
              limit={stats.uploadsToday + stats.uploadsRemainingToday}
            />
            <Meter
              label="Spend today"
              used={stats.cost.todayMicros}
              limit={stats.cost.dailyLimitMicros}
              format={formatUsd}
            />
            <Meter
              label="Spend this month"
              used={stats.cost.monthMicros}
              limit={stats.cost.monthlyLimitMicros}
              format={formatUsd}
            />
            <dl className="grid grid-cols-2 gap-2 border-t pt-3 text-xs">
              <div>
                <dt className="text-[var(--color-text-muted)]">Cost per video</dt>
                <dd className="tabular-nums">{formatUsd(stats.cost.costPerVideoMicros)}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-text-muted)]">Per published video</dt>
                <dd className="tabular-nums">
                  {formatUsd(stats.cost.costPerPublishedVideoMicros)}
                </dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card
          title="Top videos"
          description="Ranked by performance score, not raw views."
          className="lg:col-span-2"
          actions={
            <Link href="/videos" className="btn btn-ghost">
              All videos
            </Link>
          }
        >
          {stats.topVideos.length === 0 ? (
            <EmptyState
              title="Nothing published yet"
              description="Once a video goes live, its performance appears here."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th className="text-right">Views</th>
                    <th className="text-right">Likes</th>
                    <th className="text-right">Score</th>
                    <th>Published</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.topVideos.map((video) => (
                    <tr key={video.id}>
                      <td>
                        <Link href={`/videos/${video.id}`} className="hover:underline">
                          {truncate(video.title ?? 'Untitled', 48)}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge status={video.status} />
                      </td>
                      <td className="text-right tabular-nums">{formatNumber(video.views)}</td>
                      <td className="text-right tabular-nums">{formatNumber(video.likes)}</td>
                      <td className="text-right tabular-nums">
                        {video.performanceScore?.toFixed(0) ?? '—'}
                      </td>
                      <td className="text-[var(--color-text-muted)]">
                        {formatRelative(video.publishedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Recent errors"
        description="The last failures recorded by the platform."
        className="mt-4"
        actions={
          <Link href="/logs" className="btn btn-ghost">
            All logs
          </Link>
        }
      >
        {stats.recentErrors.length === 0 ? (
          <EmptyState title="No errors recorded" />
        ) : (
          <ul className="divide-y">
            {stats.recentErrors.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="font-mono text-xs text-[var(--color-text-faint)]">
                  {formatDateTime(entry.at)}
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
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
