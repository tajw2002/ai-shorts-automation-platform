import Link from 'next/link';
import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, EmptyState, ErrorNote, Stat } from '@/components/ui';
import { ViewsChart } from '@/components/views-chart';
import { formatDateTime, formatNumber, formatRelative, truncate } from '@/lib/format';
import type { AnalyticsOverview } from '@shorts/contracts';

export const metadata = { title: 'Analytics · AI Shorts' };
export const dynamic = 'force-dynamic';

const EMPTY: AnalyticsOverview = {
  totals: { views: 0, likes: 0, comments: 0, published: 0 },
  series: [],
  topVideos: [],
  insights: [],
  insightsGeneratedAt: null,
};

export default async function AnalyticsPage() {
  const { data, error } = await apiFetchSafe<AnalyticsOverview>('/analytics?days=30', EMPTY);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Performance of published videos, and the patterns the platform has learned from them."
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Published" value={formatNumber(data.totals.published)} />
        <Stat label="Views" value={formatNumber(data.totals.views)} />
        <Stat label="Likes" value={formatNumber(data.totals.likes)} />
        <Stat label="Comments" value={formatNumber(data.totals.comments)} />
      </div>

      <Card
        title="Views over time"
        description="Daily totals across every published video."
        className="mb-4"
      >
        {data.series.length === 0 ? (
          <EmptyState
            title="No analytics yet"
            description="Data appears after the first video is published and synced."
          />
        ) : (
          <ViewsChart series={data.series} />
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top performers" description="Ranked by performance score.">
          {data.topVideos.length === 0 ? (
            <EmptyState title="Nothing published yet" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th className="text-right">Views</th>
                    <th className="text-right">Score</th>
                    <th>Published</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topVideos.map((video) => (
                    <tr key={video.id}>
                      <td>
                        <Link href={`/videos/${video.id}`} className="hover:underline">
                          {truncate(video.title ?? 'Untitled', 36)}
                        </Link>
                      </td>
                      <td className="text-right tabular-nums">{formatNumber(video.views)}</td>
                      <td className="text-right tabular-nums">
                        {video.performanceScore?.toFixed(0) ?? '—'}
                      </td>
                      <td className="text-xs text-[var(--color-text-muted)]">
                        {formatRelative(video.publishedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Learned patterns"
          description={
            data.insightsGeneratedAt
              ? `Structural patterns only — never a specific video to copy. Generated ${formatDateTime(data.insightsGeneratedAt)}.`
              : 'Structural patterns only — never a specific video to copy.'
          }
        >
          {data.insights.length === 0 ? (
            <EmptyState
              title="Not enough data"
              description="Patterns are derived once several videos have been published and measured."
            />
          ) : (
            <ul className="space-y-3">
              {data.insights.map((insight, index) => (
                <li key={`${insight.dimension}-${index}`} className="rounded-md border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <Badge tone="accent">{insight.dimension}</Badge>
                    <span className="text-xs text-[var(--color-text-faint)]">
                      confidence {(insight.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="text-sm">{insight.observation}</p>
                  <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                    → {insight.recommendation}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
