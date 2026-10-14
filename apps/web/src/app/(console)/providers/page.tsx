import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, ErrorNote } from '@/components/ui';
import type { ProvidersOverview } from '@shorts/contracts';

export const metadata = { title: 'Providers · AI Shorts' };
export const dynamic = 'force-dynamic';

export default async function ProvidersPage() {
  const { data, error } = await apiFetchSafe<ProvidersOverview>('/system/providers', {
    providers: [],
    dryRun: true,
  });

  return (
    <>
      <PageHeader
        title="Providers"
        description="Which implementation is wired behind each port, and whether it is configured."
        actions={data.dryRun ? <Badge tone="info">Dry run</Badge> : undefined}
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        {data.providers.map((provider) => (
          <Card key={provider.kind}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{provider.kind}</h3>
              <Badge tone="accent">{provider.implementation}</Badge>
              <Badge tone={provider.configured ? 'ok' : 'warn'}>
                {provider.configured ? 'configured' : 'not configured'}
              </Badge>
              {provider.forcedMock && <Badge tone="info">forced mock by DRY_RUN</Badge>}
            </div>

            <dl className="space-y-1 text-xs">
              {Object.entries(provider.details).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">{key}</dt>
                  <dd className="truncate text-right font-mono">
                    {value === null || value === '' ? '—' : String(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        ))}
      </div>
    </>
  );
}
