'use client';

import { useState } from 'react';
import { request, ClientApiError } from '@/lib/client';

/**
 * Starts the OAuth handshake.
 *
 * The API returns the consent URL rather than redirecting, so the operator is
 * told what is about to happen before they leave the console — connecting a
 * channel grants upload rights, which deserves a beat of warning.
 */
export function ConnectChannelButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await request<{ url: string }>('/channels/connect', { method: 'POST' });
      window.location.href = result.url;
    } catch (failure) {
      setError(
        failure instanceof ClientApiError ? failure.message : 'Could not start the connection.',
      );
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn btn-primary" onClick={connect} disabled={pending}>
        {pending ? 'Redirecting…' : 'Connect a channel'}
      </button>
      {error && (
        <p role="alert" className="max-w-sm text-right text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
