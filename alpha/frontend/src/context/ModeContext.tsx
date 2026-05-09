import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type UIMode = 'basic' | 'advanced';

interface ModeContextValue {
  mode: UIMode;
  setMode: (m: UIMode) => void;
  toggleMode: () => void;
}

const ModeContext = createContext<ModeContextValue | undefined>(undefined);

const STORAGE_KEY = 'vaipakam.uiMode';

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UIMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'advanced' ? 'advanced' : 'basic';
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const setMode = (m: UIMode) => setModeState(m);
  const toggleMode = () => setModeState((m) => (m === 'basic' ? 'advanced' : 'basic'));

  return (
    <ModeContext.Provider value={{ mode, setMode, toggleMode }}>
      {children}
    </ModeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useMode() {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error('useMode must be used within ModeProvider');
  return ctx;
}
