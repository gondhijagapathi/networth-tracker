/**
 * Privacy blur.
 *
 * One tap hides every amount on screen, for checking your net worth on a phone in a queue.
 * The values stay in the DOM — this is not a security boundary, it is a shoulder — and the
 * blur is a single CSS class on the root, so nothing has to be told about it twice.
 *
 * The preference is per browser rather than per account: it is about where you are sitting,
 * not who you are.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'nw:privacy';

interface PrivacyValue {
  hidden: boolean;
  toggle: () => void;
}

const PrivacyContext = createContext<PrivacyValue | null>(null);

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // Private windows and blocked site data both throw here.
      return false;
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('privacy-on', hidden);
    try {
      localStorage.setItem(STORAGE_KEY, hidden ? '1' : '0');
    } catch {
      // The preference simply won't persist. The app still works.
    }
  }, [hidden]);

  const value = useMemo<PrivacyValue>(
    () => ({ hidden, toggle: () => setHidden((previous) => !previous) }),
    [hidden],
  );

  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>;
}

export function usePrivacy(): PrivacyValue {
  const value = useContext(PrivacyContext);
  if (value === null) throw new Error('usePrivacy must be used inside a PrivacyProvider');
  return value;
}

/** Imperative escape hatch for the keyboard shortcut, which lives outside the tree. */
export function usePrivacyShortcut(): void {
  const { toggle } = usePrivacy();
  const handler = useCallback(
    (event: KeyboardEvent) => {
      // Plain `h`, but not while typing into a field.
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === 'h') {
        toggle();
      }
    },
    [toggle],
  );

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}
