'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { request, ClientApiError } from '@/lib/client';

export function GenerateIdeasButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await request('/ideas/generate', {
        method: 'POST',
        body: { count: 3, usePerformanceInsights: true },
      });
      router.refresh();
    } catch (failure) {
      // A rejection here is usually the anti-repetition layer doing its job, so
      // the message is worth showing in full rather than as a generic failure.
      setError(failure instanceof ClientApiError ? failure.message : 'Generation failed.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className="btn btn-primary" onClick={generate} disabled={pending}>
        {pending ? 'Generating…' : 'Generate ideas'}
      </button>
      {error && (
        <p role="alert" className="max-w-md text-right text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
    </div>
  );
}

export function ProduceVideoButton({ ideaId }: { ideaId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function produce(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await request<{ id: string }>('/videos', {
        method: 'POST',
        body: { ideaId },
      });
      router.push(`/videos/${result.id}`);
    } catch (failure) {
      setError(failure instanceof ClientApiError ? failure.message : 'Could not start production.');
      setPending(false);
    }
  }

  return (
    <div className="text-right">
      <button type="button" className="btn btn-ghost" onClick={produce} disabled={pending}>
        {pending ? 'Starting…' : 'Produce video'}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
    </div>
  );
}
