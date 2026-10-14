'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { request, ClientApiError } from '@/lib/client';

/**
 * Approve / reject controls.
 *
 * Rejection asks for a note, because "why was this rejected" is the question the
 * content engine needs answered later and the one an operator forgets by morning.
 */
export function ReviewActions({ videoId }: { videoId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  async function submit(decision: 'approve' | 'reject'): Promise<void> {
    setPending(decision);
    setError(null);
    try {
      await request(`/videos/${videoId}/review`, {
        method: 'POST',
        body: { decision, note: note.trim() || undefined },
      });
      router.refresh();
    } catch (failure) {
      setError(failure instanceof ClientApiError ? failure.message : 'Action failed.');
    } finally {
      setPending(null);
      setRejecting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      {rejecting ? (
        <div className="flex flex-col items-end gap-2">
          <label className="sr-only" htmlFor={`note-${videoId}`}>
            Reason for rejection
          </label>
          <input
            id={`note-${videoId}`}
            className="input sm:w-72"
            placeholder="Why is this being rejected?"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            autoFocus
          />
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost" onClick={() => setRejecting(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => submit('reject')}
              disabled={pending !== null}
            >
              {pending === 'reject' ? 'Rejecting…' : 'Confirm rejection'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setRejecting(true)}
            disabled={pending !== null}
          >
            Reject
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => submit('approve')}
            disabled={pending !== null}
          >
            {pending === 'approve' ? 'Approving…' : 'Approve'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
