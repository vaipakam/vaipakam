import { useQuery } from '@tanstack/react-query';
import { fetchWalletClaimables } from '@vaipakam/defi-client';
import type { Address } from 'viem';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useDiamondPublicClient, useReadChain } from './useDiamond';

export function useClaimables() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();
  const publicClient = useDiamondPublicClient();

  return useQuery({
    queryKey: ['claimables', chain.chainId, address, origin, chain.diamondAddress],
    enabled: Boolean(address && origin),
    queryFn: async () => {
      if (!address || !origin) return null;
      return fetchWalletClaimables(origin, chain.chainId, address, {
        publicClient,
        diamondAddress: chain.diamondAddress as Address | null,
      });
    },
    staleTime: 20_000,
  });
}