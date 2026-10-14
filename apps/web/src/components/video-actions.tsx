'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { request, ClientApiError } from '@/lib/client';
import type { VideoStatus } from '@shorts/contracts';

/**
 * Operator actions on a single video.
 *
 * Which actions are offered follows the video's state: approving something that
 * is still rendering, or publishing something not yet approved, would be refused
 * by the API anyway, so the UI does not offer it.
 */
export function VideoActions({ video }: { video: { id: string; status: VideoStatus } }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(label: string, path: string, body?: unknown): Promise<void> {
    setPending(label);
    setError(null);
    try {
      await request(path, { method: 'POST', body });
      router.refresh();
    } catch (failure) {
      setError(failure instanceof ClientApiError ? failure.message : 'Action failed.');
    } finally {
      setPending(null);
    }
  }

  const canReview = video.status === 'READY_FOR_REVIEW';
  const canPublish = video.status === 'APPROVED';
  const canCancelPublish = video.status === 'QUEUED' || video.status === 'UPLOADING';
  const canRegenerate = video.status !== 'PUBLISHED' && video.status !== 'UPLOADING';

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        {canReview && (
          <>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={pending !== null}
              onClick={() => act('reject', `/videos/${video.id}/review`, { decision: 'reject' })}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending !== null}
              onClick={() => act('approve', `/videos/${video.id}/review`, { decision: 'approve' })}
            >
              {pending === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          </>
        )}

        {canPublish && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending !== null}
            onClick={() => act('publish', `/videos/${video.id}/publish`, { publishAt: null })}
          >
            {pending === 'publish' ? 'Queueing…' : 'Publish now'}
          </button>
        )}

        {canCancelPublish && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={pending !== null}
            onClick={() => act('cancel', `/videos/${video.id}/publish/cancel`)}
          >
            Cancel publication
          </button>
        )}

        {canRegenerate && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={pending !== null}
            onClick={() =>
              act('regenerate', `/videos/${video.id}/regenerate`, { from: 'assembly' })
            }
          >
            {pending === 'regenerate' ? 'Restarting…' : 'Re-assemble'}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="max-w-md text-right text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
