export type Theme = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'nw:theme';

/**
 * Theme preference. Stored per browser — a UI convenience, not account state,
 * so localStorage is the right home for it. Every access is guarded: private
 * windows and blocked site data make these throw.
 */
export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light' || stored === 'system') return stored;
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return 'system';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Preference simply won't persist. The app still works.
  }
}
