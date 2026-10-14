import { apiFetchSafe } from '@/lib/api';
import { PageHeader } from '@/components/page-header';
import { Card, ErrorNote } from '@/components/ui';
import { SettingsForm, EmergencyStopControl } from '@/components/settings-form';

export const metadata = { title: 'Settings · AI Shorts' };
export const dynamic = 'force-dynamic';

export interface SettingsPayload {
  emergencyStop: boolean;
  generationPaused: boolean;
  uploadsPaused: boolean;
  autoPublish: boolean;
  requireApproval: boolean;
  approvalMode: string;
  maxDailyUploads: number;
  maxMonthlyUploads: number;
  maxDailyCostUsd: number;
  maxMonthlyCostUsd: number;
  defaultPrivacyStatus: string;
  subtitlesEnabled: boolean;
  readOnly: { dryRun: boolean; timezone: string; niche: string; version: string };
}

const FALLBACK: SettingsPayload = {
  emergencyStop: false,
  generationPaused: false,
  uploadsPaused: false,
  autoPublish: false,
  requireApproval: true,
  approvalMode: 'MANUAL',
  maxDailyUploads: 3,
  maxMonthlyUploads: 60,
  maxDailyCostUsd: 10,
  maxMonthlyCostUsd: 200,
  defaultPrivacyStatus: 'private',
  subtitlesEnabled: true,
  readOnly: { dryRun: true, timezone: 'Europe/Berlin', niche: '', version: '' },
};

export default async function SettingsPage() {
  const { data, error } = await apiFetchSafe<SettingsPayload>('/system/settings', FALLBACK);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Runtime controls. These take effect immediately and override the values the process booted with."
      />

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SettingsForm settings={data} />
        </div>

        <div className="space-y-4">
          <Card
            title="Emergency stop"
            description="Halts all generation and publishing, and cancels queued work."
          >
            <EmergencyStopControl active={data.emergencyStop} />
          </Card>

          <Card
            title="Environment"
            description="Set at boot; change these in the environment and redeploy."
          >
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-text-muted)]">Dry run</dt>
                <dd className="font-mono">{String(data.readOnly.dryRun)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-text-muted)]">Timezone</dt>
                <dd className="font-mono">{data.readOnly.timezone}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-text-muted)]">Niche</dt>
                <dd className="truncate font-mono">{data.readOnly.niche}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[var(--color-text-muted)]">Version</dt>
                <dd className="font-mono">{data.readOnly.version}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
