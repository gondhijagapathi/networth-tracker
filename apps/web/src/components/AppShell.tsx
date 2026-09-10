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
  {
    to: '/planner',
    label: 'Planner',
    icon: (
      <path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7ZM5 9h14v11H5V9Zm2 2v2h2v-2H7Zm4 0v2h2v-2h-2Zm4 0v2h2v-2h-2Zm-8 4v2h2v-2H7Zm4 0v2h2v-2h-2Z" />
    ),
  },
  {
    to: '/vault',
    label: 'Vault',
    icon: (
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Zm0 7a2 2 0 0 1 1 3.7V15h-2v-2.3A2 2 0 0 1 12 9Z" />
    ),
  },
  {
    to: '/nominees',
    label: 'Estate',
    icon: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8a8 8 0 0 1 16 0v1H4v-1Z" />,
  },
].map(withIcon);

/**
 * Administration.
 *
 * Not in `DESTINATIONS`, and not in the tab bar. The bottom tabs are the sections a person
 * *checks* — six of them already share a phone's width — while administration is occasional
 * operational chrome, closer to "sign out" than to "assets". So it sits with the controls at
 * the foot of the sidebar, and beside them in the mobile header.
 */
/**
 * Household and Settings.
 *
 * Both were candidates for the tab bar and neither earns a place in it. The six tabs are the
 * sections a person *checks* — six already share a phone's width — while a household is
 * configured once and settings are visited when something needs changing. So they sit with
 * the controls at the foot of the sidebar, and beside them in the mobile header, which is
 * the same call this file already made for administration.
 */
const HOUSEHOLD: Destination = withIcon({
  to: '/household',
  label: 'Household',
  icon: <path d="M12 3 3 8v3h18V8l-9-5ZM5 13v8h4v-5h6v5h4v-8H5Z" />,
});

const SETTINGS: Destination = withIcon({
  to: '/settings',
  label: 'Settings',
  icon: (
    <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9.4 4a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L16.5 3h-4l-.4 2.6c-.7.3-1.4.7-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2l.4 2.6h4l.4-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z" />
  ),
});

const ADMIN: Destination = withIcon({
  to: '/admin',
  label: 'Admin',
  icon: (
    <path d="M12 1 3 5v6c0 5.6 3.8 10.7 9 12 5.2-1.3 9-6.4 9-12V5l-9-4Zm0 6a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm0 11.5a5.5 5.5 0 0 1-4.4-2.2c.1-1.5 3-2.3 4.4-2.3s4.3.8 4.4 2.3A5.5 5.5 0 0 1 12 18.5Z" />
  ),
});

/**
 * The heir's destination.
 *
 * Kept out of the main list because it is the *replacement* for the owner-only tabs rather
 * than an addition to them — a nominee has no estate of their own to administer.
 */
const INHERITANCE: Destination = withIcon({
  to: '/inheritance',
  label: 'Inheritance',
  icon: <path d="M12 3 3 8v3h18V8l-9-5Zm-7 10v6H3v2h18v-2h-2v-6h-2v6h-3v-6h-2v6H7v-6H5Z" />,
});

/** Wrap a path in the one SVG frame every icon shares. */
function withIcon(entry: { to: string; label: string; icon: ReactNode }): Destination {
  return {
    ...entry,
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        {entry.icon}
      </svg>
    ),
  };
}

export function AppShell({ children }: { children: ReactNode }) {
  const { user, logout } = useSession();
  const { hidden, toggle } = usePrivacy();
  const [theme, setTheme] = useState<Theme>(() => readTheme());

  usePrivacyShortcut();

  /*
   * A nominee account owns nothing and administers nobody, so the destinations that only
   * make sense for an owner are replaced by the one that does. Routing still permits the
   * others — the read-only guard and the scoped repository are what enforce anything — but
   * a tab bar offering "Add nominee" to somebody with no assets is just noise.
   */
  const destinations: Destination[] =
    user?.role === 'nominee' ? [DESTINATIONS[0]!, DESTINATIONS[1]!, INHERITANCE] : DESTINATIONS;

  // A nominee has no household to merge and nothing to administer, but they still choose how
  // numbers read on their own screen.
  const secondary: Destination[] =
    user?.role === 'nominee'
      ? [SETTINGS]
      : user?.role === 'admin'
        ? [HOUSEHOLD, ADMIN, SETTINGS]
        : [HOUSEHOLD, SETTINGS];

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <div className="min-h-dvh lg:flex">
      {/*
       * The skip link. Visually hidden until it has focus, which is the first thing Tab
       * reaches on every page — without it, a keyboard user tabs through six navigation
       * items before arriving at the content, on every navigation.
       */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/*
       * The sidebar is pinned, not scrolled.
       *
       * `sticky top-0` with its own `h-dvh` keeps the destinations in place while the
       * numbers scroll past them — a person checking a long asset list should not have to
       * scroll back up to change section. The explicit height also stops the flex container
       * stretching it, which is what would otherwise make `sticky` a no-op here, and
       * `overflow-y-auto` gives the list its own scroll on a short window rather than
       * cutting the controls off at the bottom.
       */}
      <aside
        className="hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-56 lg:shrink-0 lg:flex-col lg:gap-1 lg:overflow-y-auto lg:border-r lg:px-3 lg:py-5"
        style={{ background: 'var(--surface-sunken)' }}
      >
        <div className="mb-4 px-2">
          <p className="text-sm font-semibold tracking-tight">Net Worth</p>
          <p className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
            {user?.name}
          </p>
        </div>

        <nav className="contents" aria-label="Sections">
          {destinations.map((destination) => (
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
        </nav>

        <div className="mt-auto space-y-1 px-1 pt-4">
          <nav className="contents" aria-label="Account and settings">
            {secondary.map((destination) => (
              <NavLink
                key={destination.to}
                to={destination.to}
                className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
              >
                {destination.icon}
                <span>{destination.label}</span>
              </NavLink>
            ))}
          </nav>
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
            <div className="flex items-center gap-1">
              {secondary.map((destination) => (
                <NavLink
                  key={destination.to}
                  to={destination.to}
                  className="btn btn-ghost"
                  aria-label={destination.label}
                >
                  {destination.icon}
                </NavLink>
              ))}
              <Button variant="ghost" onClick={toggle} aria-pressed={hidden}>
                {hidden ? 'Show' : 'Hide'}
              </Button>
              <Button variant="ghost" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </div>
        </header>

        {/*
         * `tabIndex={-1}` so the skip link can move focus here. Without it the browser
         * scrolls to the anchor and leaves focus on the link, and the next Tab goes back to
         * the navigation the user just asked to skip.
         *
         * The bottom padding clears the tab bar; `lg` drops it along with the bar.
         */}
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-5xl flex-1 px-4 pt-5 pb-28 outline-none lg:px-8 lg:pb-10"
        >
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
          {destinations.map((destination) => (
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
