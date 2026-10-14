import { redirect } from 'next/navigation';
import { Nav } from '@/components/nav';
import { SystemBanner } from '@/components/system-banner';
import { apiFetch, ApiError } from '@/lib/api';
import type { SessionUser } from '@shorts/contracts';

/**
 * The authenticated shell.
 *
 * Everything inside this route group requires a session. The check happens here,
 * once, rather than in each page — a page that forgot it would silently leak.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  let user: SessionUser;
  try {
    const session = await apiFetch<{ user: SessionUser }>('/auth/me', {
      redirectOnUnauthorized: false,
    });
    user = session.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login');
    throw error;
  }

  // The banner must render even when settings are unreachable, so it falls back
  // to the most conservative reading rather than showing nothing.
  const operational = await apiFetch<{
    emergencyStop: boolean;
    generationPaused: boolean;
    uploadsPaused: boolean;
    autoPublish: boolean;
    requireApproval: boolean;
    readOnly: { dryRun: boolean };
  }>('/system/settings').catch(() => null);

  return (
    <div className="lg:flex">
      <Nav userEmail={user.email} />
      <div className="min-w-0 flex-1 lg:h-screen lg:overflow-y-auto">
        {operational && (
          <SystemBanner
            operational={{
              emergencyStop: operational.emergencyStop,
              generationPaused: operational.generationPaused,
              uploadsPaused: operational.uploadsPaused,
              autoPublish: operational.autoPublish,
              requireApproval: operational.requireApproval,
              dryRun: operational.readOnly.dryRun,
            }}
          />
        )}
        <main className="p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
