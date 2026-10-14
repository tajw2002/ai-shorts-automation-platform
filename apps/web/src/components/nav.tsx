'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { request } from '@/lib/client';

/**
 * Primary navigation.
 *
 * Grouped by what an operator is actually doing — producing, publishing, or
 * running the system — rather than by which service owns the data.
 */
const SECTIONS: Array<{ heading: string; items: Array<{ href: string; label: string }> }> = [
  {
    heading: 'Overview',
    items: [{ href: '/', label: 'Dashboard' }],
  },
  {
    heading: 'Content',
    items: [
      { href: '/ideas', label: 'Ideas' },
      { href: '/characters', label: 'Characters' },
      { href: '/videos', label: 'Videos' },
      { href: '/review', label: 'Review queue' },
    ],
  },
  {
    heading: 'Publishing',
    items: [
      { href: '/publishing', label: 'Channels' },
      { href: '/schedules', label: 'Schedules' },
      { href: '/analytics', label: 'Analytics' },
    ],
  },
  {
    heading: 'System',
    items: [
      { href: '/queue', label: 'Job queue' },
      { href: '/providers', label: 'Providers' },
      { href: '/health', label: 'Health' },
      { href: '/logs', label: 'Logs' },
      { href: '/settings', label: 'Settings' },
    ],
  },
];

export function Nav({ userEmail }: { userEmail: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  async function logout(): Promise<void> {
    await request('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  }

  return (
    <>
      {/* Mobile header. The sidebar becomes a disclosure rather than a drawer, so
          it needs no focus trap and no scroll locking. */}
      <div className="flex items-center justify-between border-b px-4 py-3 lg:hidden">
        <span className="text-sm font-semibold">AI Shorts</span>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="primary-nav"
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      <nav
        id="primary-nav"
        className={`${open ? 'block' : 'hidden'} w-full shrink-0 border-b px-3 py-4 lg:block lg:h-screen lg:w-60 lg:overflow-y-auto lg:border-r lg:border-b-0`}
        aria-label="Primary"
      >
        <div className="mb-6 hidden px-2 lg:block">
          <p className="text-sm font-semibold">AI Shorts</p>
          <p className="text-xs text-[var(--color-text-faint)]">Automation Platform</p>
        </div>

        {SECTIONS.map((section) => (
          <div key={section.heading} className="mb-5">
            <p className="mb-1 px-2 text-[10px] font-semibold tracking-wider text-[var(--color-text-faint)] uppercase">
              {section.heading}
            </p>
            <ul>
              {section.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={isActive(item.href) ? 'page' : undefined}
                    className={`block rounded-md px-2 py-1.5 text-sm transition-colors ${
                      isActive(item.href)
                        ? 'bg-[var(--color-surface-hover)] font-medium text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="mt-auto border-t px-2 pt-4">
          <p className="truncate text-xs text-[var(--color-text-faint)]" title={userEmail}>
            {userEmail}
          </p>
          <button type="button" onClick={logout} className="btn btn-ghost mt-2 w-full">
            Sign out
          </button>
        </div>
      </nav>
    </>
  );
}
