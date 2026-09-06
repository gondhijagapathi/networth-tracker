import { useEffect, useState } from 'react';
import { formatCompactINR, formatINR } from '@networth/shared';
import { applyTheme, readTheme, type Theme } from './lib/theme.js';

/**
 * P0 shell. This exists to prove the toolchain, the theme tokens and the
 * responsive layout end to end. Real routing and data arrive in P1–P3.
 */
export function App() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [privacy, setPrivacy] = useState(false);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const netWorth = 1_24_56_789_00; // paise — placeholder until P2 lands

  return (
    <div className={privacy ? 'privacy-on min-h-dvh' : 'min-h-dvh'}>
      <header className="sticky top-0 z-10 border-b backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-sm font-semibold tracking-tight">Net Worth</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPrivacy((p) => !p)}
              className="rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ background: 'var(--surface-overlay)', color: 'var(--text-secondary)' }}
              aria-pressed={privacy}
            >
              {privacy ? 'Show amounts' : 'Hide amounts'}
            </button>
            <button
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="rounded-lg px-3 py-1.5 text-xs font-medium"
              style={{ background: 'var(--surface-overlay)', color: 'var(--text-secondary)' }}
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        <section className="surface-card p-5 sm:p-6">
          <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Total net worth
          </p>
          <p className="sensitive tabular mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">
            {formatINR(netWorth, { paise: false })}
          </p>
          <p className="sensitive tabular mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {formatCompactINR(netWorth)}
          </p>
        </section>

        <p className="mt-6 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Scaffold only — see <code>docs/TASKS.md</code> for what lands next.
        </p>
      </main>
    </div>
  );
}
