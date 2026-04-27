import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Theme model:
 *
 *   - The active `theme` is always either `light` or `dark`.
 *   - The **default is the OS / browser preference** via
 *     `prefers-color-scheme`, and stays system-following until the user
 *     explicitly toggles.
 *   - The first toggle is treated as a user choice: from that moment on,
 *     the value is persisted to localStorage and the system listener is
 *     ignored. Subsequent OS theme switches don't override what the user
 *     picked.
 *
 * This is the same shape as macOS / iOS / GNOME / Windows app theming —
 * apps default to "system", and only break out into manual mode after
 * the user opens the menu and picks light or dark explicitly.
 *
 * The localStorage key (`vaipakam-theme`) doubles as the "user has
 * chosen" signal: presence ⇒ user-locked, absence ⇒ system-following.
 */

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  /** True while the theme is following the OS preference (no explicit
   *  user choice). Useful for showing "Auto" badges in the UI. */
  followingSystem: boolean;
  /** Forget any user choice and go back to following the OS preference.
   *  Available so the settings panel can offer a "Reset to system" item. */
  resetToSystem: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = 'vaipakam-theme';

function readSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Track whether the user has explicitly chosen a theme. Derived from
  // localStorage at boot; flipped to true on the first `toggleTheme`
  // call. `resetToSystem` flips it back to false.
  const [followingSystem, setFollowingSystem] = useState<boolean>(
    () => readStoredTheme() === null,
  );

  const [theme, setThemeState] = useState<Theme>(
    () => readStoredTheme() ?? readSystemTheme(),
  );

  // Apply the active theme to the DOM. This runs on every change
  // (initial mount, user toggle, OS-event-driven update) so the CSS
  // variable cascade always reflects what the rest of the app sees in
  // React state.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Persist ONLY when the user has explicitly chosen a theme. Without
  // this gate, the boot-time system-derived value would be written to
  // localStorage on the first render and lock the user out of the
  // system-following default forever.
  useEffect(() => {
    if (!followingSystem) {
      window.localStorage.setItem(STORAGE_KEY, theme);
    }
  }, [theme, followingSystem]);

  // Live-follow OS preference while the user hasn't picked one. The
  // listener is wired up only when `followingSystem` is true, and torn
  // down the moment the user toggles — that way an OS theme change
  // during a session doesn't undo a deliberate manual selection.
  useEffect(() => {
    if (!followingSystem) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      setThemeState(e.matches ? 'dark' : 'light');
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [followingSystem]);

  const toggleTheme = () => {
    setFollowingSystem(false);
    setThemeState((t) => (t === 'dark' ? 'light' : 'dark'));
  };

  const resetToSystem = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setFollowingSystem(true);
    setThemeState(readSystemTheme());
  };

  return (
    <ThemeContext.Provider
      value={{ theme, toggleTheme, followingSystem, resetToSystem }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
