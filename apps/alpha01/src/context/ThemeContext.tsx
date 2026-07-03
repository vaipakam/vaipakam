import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { readCookie, writeCookie, THEME_COOKIE } from '@vaipakam/lib/crossDomainPref';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  followingSystem: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
const STORAGE_KEY = 'vaipakam-theme';

function readSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredTheme(): Theme | null {
  const fromCookie = readCookie(THEME_COOKIE);
  if (fromCookie === 'light' || fromCookie === 'dark') return fromCookie;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [followingSystem, setFollowingSystem] = useState(() => readStoredTheme() === null);
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? readSystemTheme());

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!followingSystem) {
      writeCookie(THEME_COOKIE, theme);
      window.localStorage.setItem(STORAGE_KEY, theme);
    }
  }, [theme, followingSystem]);

  useEffect(() => {
    if (!followingSystem) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [followingSystem]);

  const toggleTheme = () => {
    setFollowingSystem(false);
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, followingSystem }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}