import { useQuery } from '@tanstack/react-query';
import { fetchClaimables } from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useReadChain } from './useDiamond';

export function useClaimables() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = import.meta.env.VITE_INDEXER_ORIGIN;

  return useQuery({
    queryKey: ['claimables', chain.chainId, address, origin],
    enabled: Boolean(address),
    queryFn: async () => {
      if (!address) return null;
      return fetchClaimables(origin, chain.chainId, address);
    },
    staleTime: 20_000,
  });
}