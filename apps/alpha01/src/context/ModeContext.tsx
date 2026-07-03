import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type UIMode = 'basic' | 'advanced';

interface ModeContextValue {
  mode: UIMode;
  setMode: (m: UIMode) => void;
  toggleMode: () => void;
}

const ModeContext = createContext<ModeContextValue | undefined>(undefined);
const STORAGE_KEY = 'vaipakam.alpha01.uiMode';

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UIMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'advanced' ? 'advanced' : 'basic';
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return (
    <ModeContext.Provider
      value={{
        mode,
        setMode: setModeState,
        toggleMode: () => setModeState((m) => (m === 'basic' ? 'advanced' : 'basic')),
      }}
    >
      {children}
    </ModeContext.Provider>
  );
}

export function useMode() {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode must be used within ModeProvider');
  return ctx;
}