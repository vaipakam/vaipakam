import { useQuery } from '@tanstack/react-query';
import { fetchAllActiveOffers, filterBorrowerOffersForLend } from '@vaipakam/defi-client';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

export function useBorrowerOffersForLend() {
  const chain = useReadChain();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['borrower-offers', chain.chainId, origin],
    enabled: Boolean(origin),
    queryFn: async () => {
      if (!origin) return [];
      const all = await fetchAllActiveOffers(origin, chain.chainId);
      return filterBorrowerOffersForLend(all);
    },
    staleTime: 30_000,
  });
}