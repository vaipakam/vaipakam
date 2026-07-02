import { useQuery } from '@tanstack/react-query';
import {
  fetchAllActiveOffers,
  filterLenderOffersForBorrow,
} from '@vaipakam/defi-client';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

export function useLenderOffersForBorrow() {
  const chain = useReadChain();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['lender-offers', chain.chainId, origin],
    enabled: Boolean(origin),
    queryFn: async () => {
      if (!origin) return [];
      const all = await fetchAllActiveOffers(origin, chain.chainId);
      return filterLenderOffersForBorrow(all);
    },
    staleTime: 30_000,
  });
}