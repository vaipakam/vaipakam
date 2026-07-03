/**
 * Basic / Advanced mode — the single `mode` value every page reads,
 * per docs/DesignsAndPlans/BasicUserUXSimplification.md ("one shared
 * mode value in app context ... one source of truth").
 *
 * Rules the rest of the app relies on:
 *   - Default is BASIC. A first-time visitor never sees power tools.
 *   - Switching mode never navigates: pages conditionally reveal
 *     advanced controls in place, so the user keeps their spot and
 *     any in-progress form state (Journey H1 acceptance check).
 *   - Advanced is progressive disclosure, not a different product —
 *     the protocol rules are identical in both modes.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

export type AppMode = 'basic' | 'advanced';

const STORAGE_KEY = 'alpha02.mode';

interface ModeContextValue {
  mode: AppMode;
  isAdvanced: boolean;
  setMode: (m: AppMode) => void;
}

const ModeContext = createContext<ModeContextValue | null>(null);

function loadMode(): AppMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'basic' || stored === 'advanced') return stored;
  } catch {
    /* storage unavailable — default */
  }
  return 'basic';
}

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<AppMode>(loadMode);

  const setMode = useCallback((m: AppMode) => {
    setModeState(m);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* non-fatal */
    }
  }, []);

  const value = useMemo(
    () => ({ mode, isAdvanced: mode === 'advanced', setMode }),
    [mode, setMode],
  );

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode must be used inside <ModeProvider>');
  return ctx;
}
