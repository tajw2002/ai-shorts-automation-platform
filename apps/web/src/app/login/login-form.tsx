'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { request, setCsrfToken, ClientApiError } from '@/lib/client';
import type { SessionUser } from '@shorts/contracts';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result = await request<{ user: SessionUser; csrfToken: string }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setCsrfToken(result.csrfToken);
      // refresh() so the server layout re-reads the newly set session cookie.
      router.replace('/');
      router.refresh();
    } catch (failure) {
      setError(
        failure instanceof ClientApiError ? failure.message : 'Sign-in failed. Please try again.',
      );
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="mb-3">
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          className="input"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          required
          autoFocus
        />
      </div>

      <div className="mb-4">
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          className="input"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-[var(--color-error)]">
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
