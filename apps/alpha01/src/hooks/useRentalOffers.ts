import { useQuery } from '@tanstack/react-query';
import {
  fetchAllActiveOffers,
  filterBorrowerNftRentalDemands,
  filterLenderNftOffersForRent,
} from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

export function useLenderNftOffersForRent() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['nft-rental-offers', chain.chainId, origin, address],
    enabled: Boolean(origin),
    queryFn: async () => {
      if (!origin) return [];
      const all = await fetchAllActiveOffers(origin, chain.chainId);
      const wallet = address?.toLowerCase();
      return filterLenderNftOffersForRent(all).filter(
        (o) => !wallet || o.creator.toLowerCase() !== wallet,
      );
    },
    staleTime: 30_000,
  });
}

export function useBorrowerNftRentalDemands() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();

  return useQuery({
    queryKey: ['nft-rental-demands', chain.chainId, origin, address],
    enabled: Boolean(origin),
    queryFn: async () => {
      if (!origin) return [];
      const all = await fetchAllActiveOffers(origin, chain.chainId);
      const wallet = address?.toLowerCase();
      return filterBorrowerNftRentalDemands(all).filter(
        (o) => !wallet || o.creator.toLowerCase() !== wallet,
      );
    },
    staleTime: 30_000,
  });
}