import { useQuery } from '@tanstack/react-query';
import { fetchAllActiveOffers, filterBorrowerOffersForLend } from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

export function useBorrowerOffersForLend() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['borrower-offers', chain.chainId, origin, address],
    enabled: Boolean(origin),
    queryFn: async () => {
      if (!origin) return [];
      const all = await fetchAllActiveOffers(origin, chain.chainId);
      const wallet = address?.toLowerCase();
      return filterBorrowerOffersForLend(all).filter(
        (o) => !wallet || o.creator.toLowerCase() !== wallet,
      );
    },
    staleTime: 30_000,
  });
}