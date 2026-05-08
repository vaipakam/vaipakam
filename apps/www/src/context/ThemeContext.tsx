import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  readCookie,
  writeCookie,
  clearCookie,
  THEME_COOKIE,
} from '@vaipakam/lib/crossDomainPref';

/**
 * Theme model:
 *
 *   - The active `theme` is always either `light` or `dark`.
 *   - The **default is the OS / browser preference** via
 *     `prefers-color-scheme`, and stays system-following until the user
 *     explicitly toggles.
 *   - The first toggle is treated as a user choice. From that moment
 *     on, the value is persisted to BOTH a parent-domain cookie
 *     (`vaipakam_theme`, scoped to `.vaipakam.com` so the choice
 *     follows the user across labs.vaipakam.com ↔ defi.vaipakam.com)
 *     AND localStorage (belt-and-suspenders for cookie-disabled
 *     clients), and the system listener is ignored. Subsequent OS
 *     theme switches don't override what the user picked.
 *
 * This is the same shape as macOS / iOS / GNOME / Windows app theming —
 * apps default to "system", and only break out into manual mode after
 * the user opens the menu and picks light or dark explicitly.
 *
 * Boot-time read order: cookie (cross-domain truth) → localStorage
 * (same-origin fallback) → `prefers-color-scheme`. Presence of EITHER
 * the cookie or the localStorage entry counts as "user has chosen"
 * and disables the OS-listener. The localStorage key
 * (`vaipakam-theme`) is preserved verbatim so existing same-origin
 * users don't lose their preference on the migration to cookies.
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
  /** Apply a transient theme override that bypasses the user's
   *  persisted choice — the Protocol Console's mission-control view
   *  uses this to force dark CSS-variable tokens site-wide while
   *  the cockpit is engaged. Calling with `null` clears the override
   *  and restores whichever theme the user had before. The override
   *  is NOT persisted to localStorage and does NOT change the
   *  `followingSystem` flag, so when the override clears the user's
   *  prior light/dark/system-follow state is exactly what it was.
   *  Multiple consumers can call this — last writer wins; the
   *  caller is responsible for clearing on unmount. */
  setThemeOverride: (theme: Theme | null) => void;
  /** True iff a transient override is currently in force (i.e. the
   *  user is in Protocol Console mission-control view). UI surfaces
   *  that read `theme` to decide what affordance to show — most
   *  notably the site-wide theme-toggle button — should consult
   *  this flag to avoid no-op toggles and to surface a tooltip
   *  explaining where the dark theme is coming from. */
  themeOverridden: boolean;
  /** The user's underlying theme choice (or system-derived default),
   *  unaffected by any active override. The theme-toggle button uses
   *  this to render the right "would-flip-to" affordance: while
   *  mission-control is forcing dark on a baseline-light user, the
   *  baseline tells us they'd want to return to light. */
  baselineTheme: Theme;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = 'vaipakam-theme';

function readSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null;
  // Cookie (cross-domain) wins over localStorage — a fresh subdomain
  // visit may have an empty localStorage but inherit the cookie set
  // on a sibling subdomain, and we want that to count as the user's
  // choice without re-prompting them via system preference.
  const fromCookie = readCookie(THEME_COOKIE);
  if (fromCookie === 'light' || fromCookie === 'dark') return fromCookie;
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

  // Transient override (Protocol Console mission-control view). When
  // non-null, it wins over `theme` for what gets written to the DOM,
  // but isn't persisted and doesn't touch followingSystem. Cleared by
  // the consumer on unmount / mode toggle to restore the user's
  // baseline.
  const [override, setOverride] = useState<Theme | null>(null);

  // The theme actually applied to the DOM is the override (if set)
  // or the user's baseline. Consumers reading `theme` from context
  // see the override too (so the Sun/Moon icon flips correctly while
  // an override is in force).
  const effectiveTheme = override ?? theme;

  // Apply the active theme to the DOM. This runs on every change
  // (initial mount, user toggle, OS-event-driven update, override
  // engage / disengage) so the CSS variable cascade always reflects
  // what the rest of the app sees in React state.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }, [effectiveTheme]);

  // Persist ONLY when the user has explicitly chosen a theme — and
  // ONLY persist the BASELINE `theme`, never the transient override.
  // The override is intentionally non-persistent: closing the
  // browser mid-mission-control should NOT save dark as the user's
  // permanent choice.
  //
  // Dual-write to cookie + localStorage:
  //   - Cookie (`Domain=.vaipakam.com`) is the cross-domain source
  //     of truth — picking dark on labs.vaipakam.com makes
  //     defi.vaipakam.com also dark on the next navigation.
  //   - localStorage is the belt-and-suspenders fallback for
  //     cookie-disabled clients (private mode, strict cookie
  //     blockers) and pre-existing same-origin users.
  useEffect(() => {
    if (!followingSystem) {
      writeCookie(THEME_COOKIE, theme);
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

  // Site-theme button handler. Always lands on the opposite of the
  // currently-rendered theme so a click is never a no-op:
  //   - No override: ordinary baseline flip.
  //   - Override active: clear the override AND set the baseline to
  //     the target. Without the baseline write, a baseline-dark user
  //     dismissing a dark Mission Control would land back on dark
  //     (no visible change). The user explicitly opted into the
  //     cockpit by visiting the dashboard, and explicitly opted out
  //     by clicking the site theme button — Reading A: the click
  //     unwinds both the override AND any underlying preference
  //     that would have masked the change.
  const toggleTheme = () => {
    setFollowingSystem(false);
    const effective: Theme = override ?? theme;
    const target: Theme = effective === 'dark' ? 'light' : 'dark';
    if (override !== null) setOverride(null);
    setThemeState(target);
  };

  const resetToSystem = () => {
    // Clear BOTH stores so the next subdomain visit also drops back
    // to system-following (otherwise the cookie would override any
    // sibling subdomain's fresh-OS read).
    clearCookie(THEME_COOKIE);
    window.localStorage.removeItem(STORAGE_KEY);
    setFollowingSystem(true);
    setThemeState(readSystemTheme());
  };

  const setThemeOverride = (next: Theme | null) => {
    setOverride(next);
  };

  return (
    <ThemeContext.Provider
      value={{
        // `theme` exposed to consumers reflects the OVERRIDE when
        // active, so theme-aware components (Sun/Moon icons, theme-
        // gated illustration swaps, etc.) flip in lockstep with the
        // DOM. The unmodified user baseline is exposed separately as
        // `baselineTheme` for the theme-toggle button's tooltip
        // copy.
        theme: effectiveTheme,
        toggleTheme,
        followingSystem,
        resetToSystem,
        setThemeOverride,
        themeOverridden: override !== null,
        baselineTheme: theme,
      }}
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
