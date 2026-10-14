'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { request, ClientApiError } from '@/lib/client';
import { Card } from './ui';
import type { SettingsPayload } from '@/app/(console)/settings/page';

/** A labelled switch. Explaining what each flag does is the point of this page. */
function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-[var(--color-text-muted)]">{description}</span>
      </span>
    </label>
  );
}

export function SettingsForm({ settings }: { settings: SettingsPayload }) {
  const router = useRouter();
  const [form, setForm] = useState(settings);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update<K extends keyof SettingsPayload>(key: K, value: SettingsPayload[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  }

  async function save(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await request('/system/settings', {
        method: 'POST',
        body: {
          generationPaused: form.generationPaused,
          uploadsPaused: form.uploadsPaused,
          autoPublish: form.autoPublish,
          requireApproval: form.requireApproval,
          approvalMode: form.approvalMode,
          maxDailyUploads: form.maxDailyUploads,
          maxMonthlyUploads: form.maxMonthlyUploads,
          maxDailyCostUsd: form.maxDailyCostUsd,
          maxMonthlyCostUsd: form.maxMonthlyCostUsd,
          defaultPrivacyStatus: form.defaultPrivacyStatus,
          subtitlesEnabled: form.subtitlesEnabled,
        },
      });
      setSaved(true);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof ClientApiError ? failure.message : 'Could not save settings.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Automation" description="How much of the pipeline runs without a person.">
        <div className="divide-y">
          <Toggle
            label="Require approval"
            description="A person must approve every video before it can be uploaded. Leave on until the pipeline has run reliably."
            checked={form.requireApproval}
            onChange={(value) => update('requireApproval', value)}
          />
          <Toggle
            label="Auto-publish"
            description="Allow the scheduler to publish approved videos publicly. Without it, uploads stay private."
            checked={form.autoPublish}
            onChange={(value) => update('autoPublish', value)}
          />
          <Toggle
            label="Pause generation"
            description="Stop producing new content. Work already in flight finishes."
            checked={form.generationPaused}
            onChange={(value) => update('generationPaused', value)}
          />
          <Toggle
            label="Pause uploads"
            description="Stop sending anything to YouTube. Production continues."
            checked={form.uploadsPaused}
            onChange={(value) => update('uploadsPaused', value)}
          />
          <Toggle
            label="Burn in subtitles"
            description="Render captions into the video. Strongly recommended for Shorts."
            checked={form.subtitlesEnabled}
            onChange={(value) => update('subtitlesEnabled', value)}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="approvalMode">
              Approval mode
            </label>
            <select
              id="approvalMode"
              className="input"
              value={form.approvalMode}
              onChange={(event) => update('approvalMode', event.target.value)}
            >
              <option value="MANUAL">Manual — approve each video</option>
              <option value="SEMI_AUTO">Semi-auto — batch review</option>
              <option value="AUTO">Auto — publish on a clean report</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="privacy">
              Default privacy
            </label>
            <select
              id="privacy"
              className="input"
              value={form.defaultPrivacyStatus}
              onChange={(event) => update('defaultPrivacyStatus', event.target.value)}
            >
              <option value="private">Private</option>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </div>
        </div>
      </Card>

      <Card title="Limits" description="Enforced before every upload and every paid provider call.">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="maxDailyUploads">
              Max uploads / day
            </label>
            <input
              id="maxDailyUploads"
              type="number"
              min={0}
              max={50}
              className="input"
              value={form.maxDailyUploads}
              onChange={(event) => update('maxDailyUploads', Number(event.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="maxMonthlyUploads">
              Max uploads / month
            </label>
            <input
              id="maxMonthlyUploads"
              type="number"
              min={0}
              max={1000}
              className="input"
              value={form.maxMonthlyUploads}
              onChange={(event) => update('maxMonthlyUploads', Number(event.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="maxDailyCost">
              Max spend / day (USD)
            </label>
            <input
              id="maxDailyCost"
              type="number"
              min={0}
              step="0.5"
              className="input"
              value={form.maxDailyCostUsd}
              onChange={(event) => update('maxDailyCostUsd', Number(event.target.value))}
            />
          </div>
          <div>
            <label className="label" htmlFor="maxMonthlyCost">
              Max spend / month (USD)
            </label>
            <input
              id="maxMonthlyCost"
              type="number"
              min={0}
              step="1"
              className="input"
              value={form.maxMonthlyCostUsd}
              onChange={(event) => update('maxMonthlyCostUsd', Number(event.target.value))}
            />
          </div>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary" onClick={save} disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="text-xs text-[var(--color-ok)]">Saved.</span>}
        {error && (
          <span role="alert" className="text-xs text-[var(--color-error)]">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The kill switch.
 *
 * Activation is one click because an emergency is not the time for a dialog;
 * deactivation is a two-step confirm because resuming is the consequential
 * direction — it is what lets money start being spent again.
 */
export function EmergencyStopControl({ active }: { active: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(enabled: boolean): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await request('/system/emergency-stop', {
        method: 'POST',
        body: { enabled, reason: enabled ? 'Activated from the dashboard.' : undefined },
      });
      router.refresh();
    } catch (failure) {
      setError(failure instanceof ClientApiError ? failure.message : 'Action failed.');
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  if (active) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-semibold text-[var(--color-error)]">The system is stopped.</p>
        {confirming ? (
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending}
              onClick={() => toggle(false)}
            >
              {pending ? 'Resuming…' : 'Yes, resume'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-ghost w-full"
            onClick={() => setConfirming(true)}
          >
            Resume the system
          </button>
        )}
        {error && (
          <p role="alert" className="text-xs text-[var(--color-error)]">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--color-text-muted)]">
        Stops all generation and publishing at once and cancels queued work.
      </p>
      <button
        type="button"
        className="btn btn-danger w-full"
        disabled={pending}
        onClick={() => toggle(true)}
      >
        {pending ? 'Stopping…' : 'Emergency stop'}
      </button>
      {error && (
        <p role="alert" className="text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
