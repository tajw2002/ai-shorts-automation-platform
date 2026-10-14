import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, EmptyState, ErrorNote, StatusBadge, toneForStatus } from '@/components/ui';
import { GenerateIdeasButton, ProduceVideoButton } from '@/components/idea-actions';
import { formatRelative } from '@/lib/format';
import type { IdeaSummary, Paginated } from '@shorts/contracts';

export const metadata = { title: 'Ideas · AI Shorts' };
export const dynamic = 'force-dynamic';

export default async function IdeasPage() {
  const { data, error } = await apiFetchSafe<Paginated<IdeaSummary>>('/ideas?pageSize=50', {
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
    totalPages: 1,
  });

  return (
    <>
      <PageHeader
        title="Ideas"
        description="Original concepts checked for safety and against everything already made."
        actions={<GenerateIdeasButton />}
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {data.items.length === 0 ? (
        <EmptyState
          title="No ideas yet"
          description="Generate a batch to get started. Each one is checked against existing content before it is kept."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((idea) => (
            <Card key={idea.id}>
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <h3 className="text-sm font-semibold">{idea.title}</h3>
                <StatusBadge status={idea.status} />
              </div>
              <p className="mb-2 text-xs text-[var(--color-text-muted)]">{idea.premise}</p>
              <p className="mb-3 text-xs italic text-[var(--color-text-faint)]">“{idea.hook}”</p>

              <div className="mb-3 flex flex-wrap gap-1">
                {idea.characterNames.map((name) => (
                  <Badge key={name}>{name}</Badge>
                ))}
                <Badge>{idea.targetDurationSeconds}s</Badge>
                <Badge>{idea.tone}</Badge>
                {idea.safetyVerdict !== 'ALLOW' && (
                  <Badge tone={toneForStatus(idea.safetyVerdict)}>
                    safety: {idea.safetyVerdict.toLowerCase()}
                  </Badge>
                )}
              </div>

              <div className="flex items-center justify-between border-t pt-2">
                <span className="text-xs text-[var(--color-text-faint)]">
                  {formatRelative(idea.createdAt)}
                </span>
                {idea.status === 'READY' && <ProduceVideoButton ideaId={idea.id} />}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
