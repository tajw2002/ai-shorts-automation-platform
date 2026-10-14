import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Badge, Card, EmptyState, ErrorNote, StatusBadge } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

export const metadata = { title: 'Schedules · AI Shorts' };
export const dynamic = 'force-dynamic';

interface ScheduleRow {
  id: string;
  name: string;
  timezone: string;
  videosPerDay: number;
  approvalMode: string;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  slots: Array<{ id: string; dayOfWeek: number | null; hour: number; minute: number }>;
  channel: { title: string } | null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default async function SchedulesPage() {
  const { data, error } = await apiFetchSafe<ScheduleRow[]>('/schedules', []);

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Publishing slots in local wall-clock time. Daylight saving is handled for you."
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {data.length === 0 ? (
        <EmptyState
          title="No schedules"
          description="A schedule publishes approved videos at fixed times and keeps the pipeline stocked ahead of them."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.map((schedule) => (
            <Card key={schedule.id}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">{schedule.name}</h3>
                <StatusBadge status={schedule.status} />
                <Badge>{schedule.approvalMode.toLowerCase()}</Badge>
              </div>

              <div className="mb-3 flex flex-wrap gap-1">
                {schedule.slots.map((slot) => (
                  <Badge key={slot.id} tone="accent">
                    {slot.dayOfWeek === null ? 'daily' : WEEKDAYS[slot.dayOfWeek]}{' '}
                    {String(slot.hour).padStart(2, '0')}:{String(slot.minute).padStart(2, '0')}
                  </Badge>
                ))}
              </div>

              <dl className="space-y-1 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Channel</dt>
                  <dd>{schedule.channel?.title ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Timezone</dt>
                  <dd className="font-mono">{schedule.timezone}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Videos per day</dt>
                  <dd className="tabular-nums">{schedule.videosPerDay}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Next run</dt>
                  <dd>{formatDateTime(schedule.nextRunAt)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-text-muted)]">Last run</dt>
                  <dd>{formatDateTime(schedule.lastRunAt)}</dd>
                </div>
              </dl>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
