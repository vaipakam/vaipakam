import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import type { CopyAccess } from '../copy/useCopy';
import { worldKey } from '../reads/identityKey';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { readInboxNewer, readInboxPage } from './inbox';

type Hex = `0x${string}`;

/** How often the inbox is re-read while the tab is visible. The push rail
 *  re-reads it sooner after a chain event; health rows, written by the
 *  keeper, arrive on this cadence. */
export const INBOX_POLL_MS = 60_000;

/** The connected wallet's inbox on its network, page by page, newest first.
 *  The header's count and the Alerts page share this one read. */
export function useInbox() {
  const { address, chainId } = useAccount();
  const chain: SupportedChain | null = address ? getSupportedChain(chainId) : null;
  const account: Hex | null = chain && address ? address : null;
  const world = useWorldRail();
  const query = useInfiniteQuery({
    queryKey: worldKey(chain?.chainId ?? 0, 'inbox', account?.toLowerCase() ?? ''),
    queryFn: ({ pageParam }) => readInboxPage(world.indexer, chain!.chainId, account!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: chain !== null && account !== null && world.indexer.origin !== null,
    refetchInterval: INBOX_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: INBOX_POLL_MS / 2,
    retry: 1,
  });
  return { chain, account, indexed: world.indexer.origin !== null, query };
}

/** How many alerts the index wrote for the connected wallet after row
 *  `seen` (null: nothing to ask yet), re-read on the inbox's cadence. */
export function useInboxNewer(seen: number | null) {
  const { address, chainId } = useAccount();
  const chain: SupportedChain | null = address ? getSupportedChain(chainId) : null;
  const account: Hex | null = chain && address ? address : null;
  const world = useWorldRail();
  return useQuery({
    queryKey: worldKey(chain?.chainId ?? 0, 'inboxNewer', account?.toLowerCase() ?? '', seen),
    queryFn: () => readInboxNewer(world.indexer, chain!.chainId, account!, seen!),
    enabled: chain !== null && account !== null && seen !== null && world.indexer.origin !== null,
    refetchInterval: INBOX_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: INBOX_POLL_MS / 2,
    retry: 1,
  });
}

/** Why the inbox could not be read, in the reader's words. */
export function inboxReason(e: unknown, indexed: boolean, text: CopyAccess['text']): string {
  if (!indexed) return text('inbox.noIndex');
  if (e instanceof IndexerUnavailable) {
    return text(e.why === 'not-configured' ? 'inbox.noIndex' : e.why === 'network' ? 'inbox.indexNetwork' : e.why === 'status' ? 'inbox.indexStatus' : 'inbox.indexShape');
  }
  return (e as Error | null)?.message ?? '';
}
