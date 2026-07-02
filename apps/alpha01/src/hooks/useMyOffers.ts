import { useQuery } from '@tanstack/react-query';
import {
  fetchAllOffersByCreator,
  fetchAllOffersByCurrentHolder,
  filterActiveOffersByCreator,
  type IndexedOffer,
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
      const [byHolder, byCreator] = await Promise.all([
        fetchAllOffersByCurrentHolder(origin, chain.chainId, address),
        fetchAllOffersByCreator(origin, chain.chainId, address),
      ]);
      const merged = new Map<number, IndexedOffer>();
      for (const offer of [...byHolder, ...byCreator]) merged.set(offer.offerId, offer);
      return filterActiveOffersByCreator([...merged.values()]);
    },
    staleTime: 20_000,
  });
}