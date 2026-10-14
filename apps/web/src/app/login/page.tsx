import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in · AI Shorts' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold">AI Shorts Automation Platform</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Sign in to the operator console.
          </p>
        </div>
        <div className="card">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
