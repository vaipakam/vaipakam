import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CHAIN_REGISTRY } from '../contracts/config';

interface ChainContextType {
  /** When set, all read hooks target this chain regardless of wallet state.
   *  When null, reads follow the wallet (or DEFAULT_CHAIN when disconnected). */
  viewChainId: number | null;
  setViewChainId: (id: number | null) => void;
}

const ChainContext = createContext<ChainContextType | undefined>(undefined);

export function ChainProvider({ children }: { children: ReactNode }) {
  const [viewChainId, setViewChainIdRaw] = useState<number | null>(null);

  const setViewChainId = useCallback((id: number | null) => {
    if (id !== null) {
      const entry = CHAIN_REGISTRY[id];
      if (!entry || !entry.diamondAddress) return;
    }
    setViewChainIdRaw(id);
  }, []);

  return (
    <ChainContext.Provider value={{ viewChainId, setViewChainId }}>
      {children}
    </ChainContext.Provider>
  );
}

// Co-locating the hook with the Provider is the established pattern in this
// repo (see ModeContext, ThemeContext, WalletContext). The react-refresh
// warning about mixed exports is a dev-only HMR optimization, not a
// correctness issue — splitting this across 4 files (× ~27 call sites each)
// isn't worth the churn for a Provider file that rarely changes.
// eslint-disable-next-line react-refresh/only-export-components
export function useChainOverride() {
  const ctx = useContext(ChainContext);
  if (!ctx) throw new Error('useChainOverride must be used within ChainProvider');
  return ctx;
}
