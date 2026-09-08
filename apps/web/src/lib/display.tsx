/**
 * How amounts are read.
 *
 * Indian numbers are spoken in lakhs and crores, not in millions and not digit by digit.
 * "One point two three crore" is how a person says what `₹1,23,00,000` is worth, and on a
 * phone it is also the only rendering that fits. `docs/INDIA-NOTES.md` asks for both and a
 * toggle between them, which is what this is.
 *
 * The preference is per browser rather than per account, exactly like the privacy blur and
 * for the same reason: it is about the screen you are looking at. The full figure never goes
 * away — `Amount` keeps it in the element's `title`, so it is one hover from being exact and
 * still selectable and searchable in the page.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'nw:compact';

interface DisplayValue {
  /** True when amounts render as `₹1.23 Cr` rather than `₹1,23,00,000.00`. */
  compact: boolean;
  toggle: () => void;
}

const DisplayContext = createContext<DisplayValue | null>(null);

export function DisplayProvider({ children }: { children: ReactNode }) {
  const [compact, setCompact] = useState(() => {
    try {
      // Compact by default on a narrow screen, where the full figure does not fit next to a
      // label anyway, and exact by default with room to show it.
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null) return stored === '1';
      return window.matchMedia('(max-width: 640px)').matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, compact ? '1' : '0');
    } catch {
      // Private windows and blocked site data both throw. The preference simply won't
      // persist, and the app still works.
    }
  }, [compact]);

  const value = useMemo<DisplayValue>(
    () => ({ compact, toggle: () => setCompact((previous) => !previous) }),
    [compact],
  );

  return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
}

export function useDisplay(): DisplayValue {
  const value = useContext(DisplayContext);
  if (value === null) throw new Error('useDisplay must be used inside a DisplayProvider');
  return value;
}
