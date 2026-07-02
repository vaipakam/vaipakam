import { useQuery } from '@tanstack/react-query';
import {
  fetchAllOffersByCurrentHolder,
  filterActiveOffersByCreator,
} from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

export function useMyOffers() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['my-offers', chain.chainId, address, origin],
    enabled: Boolean(address && origin),
    queryFn: async () => {
      if (!address || !origin) return [];
      const byHolder = await fetchAllOffersByCurrentHolder(origin, chain.chainId, address);
      return filterActiveOffersByCreator(byHolder);
    },
    staleTime: 20_000,
  });
}