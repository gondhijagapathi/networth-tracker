/**
 * The frame every signed-in screen sits in.
 *
 * Two navigations, one set of destinations. Below `lg` the tabs sit at the bottom of the
 * screen where a thumb reaches them — this app is checked one-handed, on a phone, standing
 * up — and the layout leaves room for the home indicator. From `lg` up they become a
 * sidebar, because a pointer does not need to reach anything and the vertical space is
 * better spent on the numbers.
 */

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { applyTheme, readTheme, type Theme } from '../lib/theme.js';
import { usePrivacy, usePrivacyShortcut } from '../lib/privacy.js';
import { useSession } from '../lib/session.js';
import { Button } from './ui.js';

interface Destination {
  to: string;
  label: string;
  icon: ReactNode;
}

/**
 * Inline SVG rather than an icon package: five icons do not justify a dependency, and the
 * content security policy in `app.ts` allows no third-party assets anyway.
 */
const DESTINATIONS: Destination[] = [
  {
    to: '/',
    label: 'Dashboard',
    icon: <path d="M3 13h6V3H3v10Zm0 8h6v-6H3v6Zm8 0h10V11H11v10Zm0-18v6h10V3H11Z" />,
  },
  {
    to: '/assets',
    label: 'Assets',
    icon: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
  },
  {
    to: '/performance',
    label: 'Returns',
    icon: (
      <path d="M4 19h16M6 16V9m5 7V5m5 11v-4" strokeWidth="2" fill="none" stroke="currentColor" />
    ),
  },
].map((entry) => ({
  ...entry,
  icon: (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      {entry.icon}
    </svg>
  ),
}));

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const { hidden, toggle } = usePrivacy();
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  usePrivacyShortcut();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="min-h-dvh lg:flex">
      <aside
        className="hidden lg:flex lg:w-56 lg:shrink-0 lg:flex-col lg:gap-1 lg:border-r lg:px-3 lg:py-5"
        style={{ background: 'var(--surface-sunken)' }}
      >
        <div className="mb-4 px-2">
          <p className="text-sm font-semibold tracking-tight">Net Worth</p>
          <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
            {user?.name}
          </p>
        </div>

        {DESTINATIONS.map((destination) => (
          <NavLink
            key={destination.to}
            to={destination.to}
            end={destination.to === '/'}
            className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
          >
            {destination.icon}
            <span>{destination.label}</span>
          </NavLink>
        ))}

        <div className="mt-auto space-y-1 px-1 pt-4">
          <Button variant="ghost" className="w-full justify-start" onClick={toggle}>
            {hidden ? 'Show amounts' : 'Hide amounts'}
          </Button>
          <Button
            variant="ghost"
            className="w-full justify-start"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </Button>
          <Button variant="ghost" className="w-full justify-start" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-10 border-b backdrop-blur-md lg:hidden"
          style={{ background: 'color-mix(in oklab, var(--surface-base) 85%, transparent)' }}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm font-semibold tracking-tight">Net Worth</span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={toggle} aria-pressed={hidden}>
                {hidden ? 'Show' : 'Hide'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                aria-label="Switch theme"
              >
                {theme === 'dark' ? 'Light' : 'Dark'}
              </Button>
              <Button variant="ghost" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </div>
        </header>

        {/* The bottom padding clears the tab bar; `lg` drops it along with the bar. */}
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-28 lg:px-8 lg:pb-10">
          {children}
        </main>

        <nav
          className="fixed inset-x-0 bottom-0 z-10 flex border-t backdrop-blur-md lg:hidden"
          style={{
            background: 'color-mix(in oklab, var(--surface-base) 92%, transparent)',
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
          aria-label="Sections"
        >
          {DESTINATIONS.map((destination) => (
            <NavLink
              key={destination.to}
              to={destination.to}
              end={destination.to === '/'}
              className={({ isActive }) => `tab-item ${isActive ? 'tab-item-active' : ''}`}
            >
              {destination.icon}
              <span className="text-[11px] font-medium">{destination.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
