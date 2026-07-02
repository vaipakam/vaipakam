import { useQuery } from '@tanstack/react-query';
import { fetchAllLoansForWallet, filterActiveLoans } from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useReadChain } from './useDiamond';

export function useMyLoans() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = import.meta.env.VITE_INDEXER_ORIGIN;

  return useQuery({
    queryKey: ['my-loans', chain.chainId, address, origin],
    enabled: Boolean(address),
    queryFn: async () => {
      if (!address) return [];
      const all = await fetchAllLoansForWallet(origin, chain.chainId, address);
      return filterActiveLoans(all);
    },
    staleTime: 20_000,
  });
}