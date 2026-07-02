import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchActivity } from '@vaipakam/defi-client';
import { useWallet } from '../context/WalletContext';
import { useIndexerOrigin } from './useIndexerOrigin';
import { useReadChain } from './useDiamond';

const PAGE_LIMIT = 25;

export function useIndexedActivity() {
  const chain = useReadChain();
  const { address } = useWallet();
  const origin = useIndexerOrigin();

  return useInfiniteQuery({
    queryKey: ['activity', chain.chainId, address, origin],
    enabled: Boolean(address && origin),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      if (!address || !origin) return null;
      return fetchActivity(origin, chain.chainId, {
        actor: address,
        limit: PAGE_LIMIT,
        before: pageParam,
      });
    },
    getNextPageParam: (last) => last?.nextBefore ?? undefined,
    staleTime: 20_000,
  });
}