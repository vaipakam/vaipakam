import { useMemo } from 'react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import {
  buildDiamondProxy,
  type DiamondHandle,
} from '@vaipakam/defi-client';
import { ZERO_ADDRESS } from '@vaipakam/lib/address';
import { useWallet } from '../context/WalletContext';
import { useChainOverride } from '../context/ChainContext';
import { CHAIN_REGISTRY, DEFAULT_CHAIN, type ChainConfig } from '../lib/chains';

function resolveReadChain(viewChainId: number | null, activeChain: ChainConfig | null): ChainConfig {
  if (viewChainId != null) {
    const override = CHAIN_REGISTRY[viewChainId];
    if (override?.diamondAddress) return override;
  }
  if (activeChain) return activeChain;
  return DEFAULT_CHAIN;
}

export function useReadChain(): ChainConfig {
  const { activeChain } = useWallet();
  const { viewChainId } = useChainOverride();
  return resolveReadChain(viewChainId, activeChain);
}

export function useDiamondPublicClient(): PublicClient {
  const chain = useReadChain();
  const wagmiClient = usePublicClient({ chainId: chain.chainId });
  return useMemo(
    () =>
      (wagmiClient ?? createPublicClient({ transport: http(chain.rpcUrl) })) as PublicClient,
    [wagmiClient, chain.rpcUrl],
  );
}

export function useDiamondContract(): DiamondHandle {
  const { isCorrectChain, activeChain } = useWallet();
  const { viewChainId } = useChainOverride();
  const chain = resolveReadChain(viewChainId, activeChain);
  const wagmiPublic = usePublicClient({ chainId: chain.chainId });
  const { data: wagmiWallet } = useWalletClient();

  const signerMatches =
    isCorrectChain && (viewChainId == null || viewChainId === activeChain?.chainId);

  return useMemo(() => {
    const address = (chain.diamondAddress ?? ZERO_ADDRESS) as Address;
    const publicClient = (wagmiPublic ??
      createPublicClient({ transport: http(chain.rpcUrl) })) as PublicClient;
    const walletClient = wagmiWallet && signerMatches ? wagmiWallet : null;
    return buildDiamondProxy({ address, publicClient, walletClient });
  }, [chain.diamondAddress, chain.rpcUrl, wagmiPublic, wagmiWallet, signerMatches]);
}