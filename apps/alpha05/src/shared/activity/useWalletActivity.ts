import { useInfiniteQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { getSupportedChain, type SupportedChain } from '../../chain/chains';
import { copy } from '../../content/copy';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { worldKey } from '../reads/identityKey';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { useWorldRail } from '../reads/world/WorldRailContext';
import { readActivityPage } from './activity';

type Hex = `0x${string}`;

/** How often the first page is re-read while the tab is visible; the push
 *  rail re-reads it sooner after a chain event. */
export const ACTIVITY_POLL_MS = 60_000;

/** The connected wallet's activity on its network, page by page, newest first. */
export function useWalletActivity() {
  const { address, chainId } = useAccount();
  const chain: SupportedChain | null = address ? getSupportedChain(chainId) : null;
  const account: Hex | null = chain && address ? address : null;
  const world = useWorldRail();
  const query = useInfiniteQuery({
    queryKey: worldKey(chain?.chainId ?? 0, 'walletActivity', account?.toLowerCase() ?? ''),
    queryFn: ({ pageParam }) => readActivityPage(world.indexer, chain!.chainId, account!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore,
    enabled: chain !== null && account !== null && world.indexer.origin !== null,
    refetchInterval: ACTIVITY_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: ACTIVITY_POLL_MS / 2,
    retry: 1,
  });
  return { chain, account, indexed: world.indexer.origin !== null, query };
}

/** Why the activity could not be read, in the reader's words (the index's
 *  failure kinds share the inbox's wording). */
export function activityReason(e: unknown, indexed: boolean, text: CopyAccess['text']): string {
  if (!indexed) return text('inbox.noIndex');
  if (e instanceof IndexerUnavailable) {
    return text(e.why === 'not-configured' ? 'inbox.noIndex' : e.why === 'network' ? 'inbox.indexNetwork' : e.why === 'status' ? 'inbox.indexStatus' : 'inbox.indexShape');
  }
  return (e as Error | null)?.message ?? '';
}

const KIND_KEYS: ReadonlySet<string> = new Set(Object.keys(copy.activity.kinds));

/** The catalog key for an event kind's line, or null for a kind this app has
 *  no words for (the line then says so, naming the kind). */
export function kindKey(kind: string): CopyKey | null {
  return KIND_KEYS.has(kind) ? (`activity.kinds.${kind}` as CopyKey) : null;
}

/** The catalog keys of every kind this app names, for the completeness test. */
export function namedKinds(): ReadonlySet<string> {
  return KIND_KEYS;
}
