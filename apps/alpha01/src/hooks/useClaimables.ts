import { useQuery } from '@tanstack/react-query';
import { fetchClaimables } from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

export function useClaimables() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['claimables', chain.chainId, address, origin],
    enabled: Boolean(address && origin),
    queryFn: async () => {
      if (!address || !origin) return null;
      return fetchClaimables(origin, chain.chainId, address);
    },
    staleTime: 20_000,
  });
}