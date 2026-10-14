import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, EmptyState, ErrorNote } from '@/components/ui';
import { ConnectChannelButton } from '@/components/channel-actions';
import { formatDateTime } from '@/lib/format';

export const metadata = { title: 'Channels · AI Shorts' };
export const dynamic = 'force-dynamic';

interface ChannelRow {
  id: string;
  title: string;
  handle: string | null;
  youtubeChannelId: string | null;
  isActive: boolean;
  madeForKids: boolean;
  defaultPrivacy: string;
  createdAt: string;
  credential: { scopes: string[]; updatedAt: string; accessTokenExpiresAt: string | null } | null;
  _count: { videos: number };
}

const CONNECTION_MESSAGES: Record<string, { tone: 'ok' | 'error'; text: string }> = {
  success: { tone: 'ok', text: 'Channel connected.' },
  denied: { tone: 'error', text: 'Authorisation was declined on the Google consent screen.' },
  invalid: { tone: 'error', text: 'The callback was missing its authorisation code.' },
  failed: { tone: 'error', text: 'The connection could not be completed. Check the API logs.' },
};

export default async function PublishingPage({
  searchParams,
}: {
  searchParams: Promise<{ connection?: string; channel?: string }>;
}) {
  const params = await searchParams;
  const notice = params.connection ? CONNECTION_MESSAGES[params.connection] : undefined;

  const { data, error } = await apiFetchSafe<ChannelRow[]>('/channels', []);

  return (
    <>
      <PageHeader
        title="Channels"
        description="YouTube channels this platform may publish to. Refresh tokens are encrypted at rest."
        actions={<ConnectChannelButton />}
      />

      {notice && (
        <div
          className={`mb-4 rounded-md border px-3 py-2 text-sm ${
            notice.tone === 'ok'
              ? 'border-[color-mix(in_oklch,var(--color-ok)_40%,transparent)] text-[var(--color-ok)]'
              : 'border-[color-mix(in_oklch,var(--color-error)_40%,transparent)] text-[var(--color-error)]'
          }`}
        >
          {notice.text}
          {params.channel ? ` (${params.channel})` : ''}
        </div>
      )}

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {data.length === 0 ? (
        <EmptyState
          title="No channel connected"
          description="Connect a YouTube channel to publish. Nothing can be uploaded until one is linked."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.map((channel) => (
            <Card key={channel.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{channel.title}</h3>
                <Badge tone={channel.isActive ? 'ok' : 'neutral'}>
                  {channel.isActive ? 'connected' : 'disconnected'}
                </Badge>
                {channel.madeForKids && <Badge tone="info">made for kids</Badge>}
              </div>

              <dl className="space-y-1 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Handle</dt>
                  <dd className="font-mono">{channel.handle ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Channel id</dt>
                  <dd className="truncate font-mono">{channel.youtubeChannelId ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Default privacy</dt>
                  <dd className="font-mono">{channel.defaultPrivacy}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Videos</dt>
                  <dd className="tabular-nums">{channel._count.videos}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Scopes granted</dt>
                  <dd className="tabular-nums">{channel.credential?.scopes.length ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Connected</dt>
                  <dd>{formatDateTime(channel.createdAt)}</dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
