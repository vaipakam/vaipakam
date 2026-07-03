import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useAccount, useChainId, useDisconnect, useSwitchChain } from 'wagmi';
import { useModal } from 'connectkit';
import { DEFAULT_CHAIN, getChainByChainId, isChainSupported } from '../lib/chains';
import type { ChainConfig } from '@vaipakam/defi-client';

interface WalletContextType {
  address: string | null;
  chainId: number | null;
  isConnecting: boolean;
  isCorrectChain: boolean;
  activeChain: ChainConfig | null;
  connect: () => void;
  disconnect: () => void;
  switchToAppChain: () => Promise<void>;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  const { address, isConnecting } = useAccount();
  const chainId = useChainId();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { setOpen } = useModal();

  const activeChain = useMemo(
    () => (chainId ? getChainByChainId(chainId) ?? null : null),
    [chainId],
  );

  const isCorrectChain = chainId != null && isChainSupported(chainId);

  const connect = useCallback(() => setOpen(true), [setOpen]);

  const switchToAppChain = useCallback(async () => {
    if (!switchChainAsync) return;
    await switchChainAsync({ chainId: DEFAULT_CHAIN.chainId });
  }, [switchChainAsync]);

  return (
    <WalletContext.Provider
      value={{
        address: address ?? null,
        chainId: chainId ?? null,
        isConnecting,
        isCorrectChain,
        activeChain,
        connect,
        disconnect: () => disconnect(),
        switchToAppChain,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}