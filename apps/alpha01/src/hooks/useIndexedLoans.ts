import { useQuery } from '@tanstack/react-query';
import { fetchAllLoansForWallet, filterActiveLoans } from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

export function useMyLoans() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['my-loans', chain.chainId, address, origin],
    enabled: Boolean(address && origin),
    queryFn: async () => {
      if (!address || !origin) return [];
      const all = await fetchAllLoansForWallet(origin, chain.chainId, address);
      return filterActiveLoans(all);
    },
    staleTime: 20_000,
  });
}