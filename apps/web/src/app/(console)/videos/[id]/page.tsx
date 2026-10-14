import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiFetch, apiFetchSafe, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, ErrorNote, StatusBadge, toneForStatus } from '@/components/ui';
import { VideoActions } from '@/components/video-actions';
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatUsd,
  toBrowserAssetUrl,
} from '@/lib/format';
import type { VideoDetail } from '@shorts/contracts';

export const dynamic = 'force-dynamic';

interface PublishCheck {
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  effectivePrivacyStatus: string;
  simulated: boolean;
}

export default async function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let video: VideoDetail;
  try {
    video = await apiFetch<VideoDetail>(`/videos/${id}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const { data: check } = await apiFetchSafe<PublishCheck | null>(
    `/videos/${id}/publish-check`,
    null,
  );

  const previewUrl = toBrowserAssetUrl(video.previewUrl);

  return (
    <>
      <PageHeader
        title={video.title ?? 'Untitled video'}
        description={`Created ${formatDateTime(video.createdAt)}`}
        actions={<VideoActions video={{ id: video.id, status: video.status }} />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={video.status} />
        {video.safetyVerdict && (
          <Badge tone={toneForStatus(video.safetyVerdict)}>
            safety: {video.safetyVerdict.toLowerCase()}
          </Badge>
        )}
        {video.privacyStatus && <Badge>{video.privacyStatus}</Badge>}
        <Badge>{formatDuration(video.durationSeconds)}</Badge>
        <Badge>{formatUsd(video.costMicros)} spent</Badge>
      </div>

      {video.lastError && (
        <div className="mb-4">
          <ErrorNote message={video.lastError} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {previewUrl && (
            <Card title="Preview">
              {/* Captions are burned into the render itself, so there is no
                  separate track to attach. */}
              <video
                controls
                preload="metadata"
                aria-label={`Preview of ${video.title ?? 'the rendered video'}`}
                src={previewUrl}
                className="mx-auto max-h-[70vh] w-auto rounded-md border bg-black"
              />
            </Card>
          )}

          <Card title="Metadata" description="Exactly what will be sent to YouTube.">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="label">Title</dt>
                <dd>{video.title ?? '—'}</dd>
              </div>
              <div>
                <dt className="label">Description</dt>
                <dd className="whitespace-pre-wrap text-[var(--color-text-muted)]">
                  {video.description ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="label">Tags</dt>
                <dd className="flex flex-wrap gap-1">
                  {video.tags.length > 0
                    ? video.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)
                    : '—'}
                </dd>
              </div>
              <div>
                <dt className="label">Hashtags</dt>
                <dd className="flex flex-wrap gap-1">
                  {video.hashtags.length > 0
                    ? video.hashtags.map((tag) => <Badge key={tag}>#{tag}</Badge>)
                    : '—'}
                </dd>
              </div>
            </dl>
          </Card>

          <Card
            title={`Scenes (${video.scenes.length})`}
            description="Rendered prompts and narration."
          >
            <ol className="space-y-3">
              {video.scenes.map((scene) => (
                <li key={scene.id} className="rounded-md border p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold">Scene {scene.index + 1}</span>
                    <StatusBadge status={scene.status} />
                    <span className="text-xs text-[var(--color-text-faint)]">
                      {scene.durationSeconds.toFixed(1)}s
                    </span>
                  </div>
                  {scene.voiceover && <p className="mb-2 text-sm">“{scene.voiceover}”</p>}
                  <p className="font-mono text-xs break-words text-[var(--color-text-faint)]">
                    {scene.prompt}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          {check && (
            <Card title="Publish readiness">
              <p className="mb-2 text-sm">
                {check.allowed ? (
                  <span className="text-[var(--color-ok)]">Ready to publish.</span>
                ) : (
                  <span className="text-[var(--color-error)]">Publishing is blocked.</span>
                )}
              </p>
              {check.blockers.length > 0 && (
                <ul className="mb-2 space-y-1 text-xs text-[var(--color-error)]">
                  {check.blockers.map((blocker) => (
                    <li key={blocker}>• {blocker}</li>
                  ))}
                </ul>
              )}
              {check.warnings.length > 0 && (
                <ul className="space-y-1 text-xs text-[var(--color-warn)]">
                  {check.warnings.map((warning) => (
                    <li key={warning}>• {warning}</li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {video.qualityReport && (
            <Card
              title="Quality control"
              description={`${video.qualityReport.failureCount} failures, ${video.qualityReport.warningCount} warnings`}
            >
              <ul className="space-y-1.5 text-xs">
                {video.qualityReport.checks.map((qcCheck) => (
                  <li key={qcCheck.id} className="flex items-start gap-2">
                    <Badge tone={toneForStatus(qcCheck.status)}>{qcCheck.status}</Badge>
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{qcCheck.label}</span>
                      <span className="block text-[var(--color-text-faint)]">
                        {qcCheck.message}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {video.metrics && (
            <Card title="Performance">
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="label">Views</dt>
                  <dd className="tabular-nums">{formatNumber(video.views)}</dd>
                </div>
                <div>
                  <dt className="label">Likes</dt>
                  <dd className="tabular-nums">{formatNumber(video.likes)}</dd>
                </div>
                <div>
                  <dt className="label">Comments</dt>
                  <dd className="tabular-nums">{formatNumber(video.comments)}</dd>
                </div>
                <div>
                  <dt className="label">Score</dt>
                  <dd className="tabular-nums">{video.metrics.performanceScore.toFixed(0)}</dd>
                </div>
                <div>
                  <dt className="label">Views / hour</dt>
                  <dd className="tabular-nums">{video.metrics.viewsPerHour.toFixed(1)}</dd>
                </div>
                <div>
                  <dt className="label">Like rate</dt>
                  <dd className="tabular-nums">{(video.metrics.likeRate * 100).toFixed(2)}%</dd>
                </div>
              </dl>
            </Card>
          )}

          <Card title="History">
            <ol className="space-y-2 text-xs">
              {video.statusHistory.map((event, index) => (
                <li key={`${event.at}-${index}`} className="flex gap-2">
                  <span className="shrink-0 text-[var(--color-text-faint)]">
                    {formatDateTime(event.at)}
                  </span>
                  <span className="min-w-0">
                    <StatusBadge status={event.status} />
                    {event.note && (
                      <span className="mt-0.5 block text-[var(--color-text-muted)]">
                        {event.note}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </Card>

          {video.youtubeUrl && (
            <Card title="On YouTube">
              <a
                href={video.youtubeUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="text-sm break-all hover:underline"
              >
                {video.youtubeUrl} ↗
              </a>
            </Card>
          )}

          {video.ideaId && (
            <Link href={`/ideas`} className="btn btn-ghost w-full">
              View source idea
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
