import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CHAIN_REGISTRY } from '../lib/chains';

interface ChainContextType {
  viewChainId: number | null;
  setViewChainId: (id: number | null) => void;
}

const ChainContext = createContext<ChainContextType | undefined>(undefined);

export function ChainProvider({ children }: { children: ReactNode }) {
  const [viewChainId, setViewChainIdRaw] = useState<number | null>(null);

  const setViewChainId = useCallback((id: number | null) => {
    if (id !== null) {
      const entry = CHAIN_REGISTRY[id];
      if (!entry?.diamondAddress) return;
    }
    setViewChainIdRaw(id);
  }, []);

  return (
    <ChainContext.Provider value={{ viewChainId, setViewChainId }}>
      {children}
    </ChainContext.Provider>
  );
}

export function useChainOverride() {
  const ctx = useContext(ChainContext);
  if (!ctx) throw new Error('useChainOverride must be used within ChainProvider');
  return ctx;
}