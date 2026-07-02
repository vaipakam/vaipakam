import { useQuery } from '@tanstack/react-query';
import {
  fetchAllActiveOffers,
  filterLenderOffersForBorrow,
} from '@vaipakam/defi-client';
import { useReadChain } from './useDiamond';

export function useLenderOffersForBorrow() {
  const chain = useReadChain();
  const origin = import.meta.env.VITE_INDEXER_ORIGIN;

  return useQuery({
    queryKey: ['lender-offers', chain.chainId, origin],
    queryFn: async () => {
      const all = await fetchAllActiveOffers(origin, chain.chainId);
      return filterLenderOffersForBorrow(all);
    },
    staleTime: 30_000,
  });
}