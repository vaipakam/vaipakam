import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Basic / Advanced mode (RB-MODE). Mode is defined PER CAPABILITY, not per
 * page: a page shows its Basic capabilities in Basic mode and adds its
 * Advanced ones in Advanced mode (the page map in the rulebook §4; each
 * matrix row carries its tier). The toggle never hides a tier-A text, a
 * blocker or a remedy. The storage key is shared with apps/app so the
 * choice carries over at the cutover.
 */
export type AppMode = 'basic' | 'advanced';

const STORAGE_KEY = 'app.mode';

interface ModeContextValue {
  mode: AppMode;
  setMode: (m: AppMode) => void;
  isAdvanced: boolean;
}

const ModeContext = createContext<ModeContextValue | null>(null);

function readStored(): AppMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'advanced' ? 'advanced' : 'basic';
  } catch {
    return 'basic';
  }
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppMode>(readStored);
  const setMode = useCallback((m: AppMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* storage blocked: the in-memory mode still applies */
    }
  }, []);
  const value = useMemo(() => ({ mode, setMode, isAdvanced: mode === 'advanced' }), [mode, setMode]);
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode outside ModeProvider');
  return ctx;
}
