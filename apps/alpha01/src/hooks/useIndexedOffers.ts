import { useQuery } from '@tanstack/react-query';
import {
  fetchAllActiveOffers,
  filterLenderOffersForBorrow,
} from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

export function useLenderOffersForBorrow() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['lender-offers', chain.chainId, origin, address],
    enabled: Boolean(origin && address),
    queryFn: async () => {
      if (!origin) return [];
      const all = await fetchAllActiveOffers(origin, chain.chainId);
      const wallet = address?.toLowerCase();
      return filterLenderOffersForBorrow(all).filter(
        (o) => !wallet || o.creator.toLowerCase() !== wallet,
      );
    },
    staleTime: 30_000,
  });
}