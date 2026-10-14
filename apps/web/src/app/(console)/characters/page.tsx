import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, EmptyState, ErrorNote } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import type { CharacterSummary, Paginated } from '@shorts/contracts';

export const metadata = { title: 'Characters · AI Shorts' };
export const dynamic = 'force-dynamic';

export default async function CharactersPage() {
  const { data, error } = await apiFetchSafe<Paginated<CharacterSummary>>(
    '/characters?pageSize=50',
    { items: [], page: 1, pageSize: 50, total: 0, totalPages: 1 },
  );

  return (
    <>
      <PageHeader
        title="Characters"
        description="The library that keeps recurring figures looking the same from video to video."
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {data.items.length === 0 ? (
        <EmptyState title="No characters defined" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((character) => (
            <Card key={character.id}>
              <div className="mb-2 flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold">{character.name}</h3>
                <Badge tone={character.isActive ? 'ok' : 'neutral'}>
                  {character.isActive ? 'active' : 'retired'}
                </Badge>
              </div>
              <p className="mb-3 text-xs text-[var(--color-text-muted)]">{character.description}</p>
              <div className="flex flex-wrap items-center gap-1 border-t pt-2 text-xs">
                <Badge>{character.species}</Badge>
                <Badge>rev {character.promptRevision}</Badge>
                <Badge>{character.usageCount} ideas</Badge>
                <span className="ml-auto text-[var(--color-text-faint)]">
                  {formatRelative(character.createdAt)}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
