import { useQuery } from '@tanstack/react-query';
import { fetchAllActiveOffers, filterBorrowerOffersForLend } from '@vaipakam/defi-client';
import { useReadChain } from './useDiamond';

export function useBorrowerOffersForLend() {
  const chain = useReadChain();
  const origin = import.meta.env.VITE_INDEXER_ORIGIN;

  return useQuery({
    queryKey: ['borrower-offers', chain.chainId, origin],
    queryFn: async () => {
      const all = await fetchAllActiveOffers(origin, chain.chainId);
      return filterBorrowerOffersForLend(all);
    },
    staleTime: 30_000,
  });
}