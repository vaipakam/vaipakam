/**
 * Light/dark theme state — one source of truth for the whole app.
 *
 * Preference model: 'light' | 'dark' | 'system'. 'system' follows the
 * OS via prefers-color-scheme and updates live when the OS switches.
 * The resolved theme is written to <html data-theme="..."> which is
 * what tokens.css keys on; an inline script in index.html applies the
 * same value before first paint so there is no flash.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'app.theme';

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
  /** Return to the default WITHOUT writing storage (#1960 review round
   *  1 P2). The data-rights erasure needs the live UI to follow the
   *  storage it just cleared; calling `setPreference` would do that and
   *  immediately re-persist the key, undoing the erasure it was called
   *  to complete. */
  resetToDefault: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function loadPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    /* storage unavailable (private mode) — fall through */
  }
  return 'system';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(loadPreference);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = preference === 'system' ? system : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* non-fatal */
    }
  }, []);

  // State only — deliberately no write. See `resetToDefault` above.
  const resetToDefault = useCallback(() => setPreferenceState('system'), []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, resetToDefault }),
    [preference, resolved, setPreference, resetToDefault],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
