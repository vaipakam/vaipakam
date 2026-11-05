/**
 * A chain read that belongs to no one (RB-RAILS): the protocol's own posture
 * (its pause state, its numeraire), a token's symbol and decimals. It is read
 * on the chain the screen describes, which is the wallet's network when the
 * app serves it and the default network otherwise, so a visitor with no
 * wallet sees the same posture a connected user does. The read goes through
 * the chain's configured endpoints (the read-only proxy, then the public
 * endpoint); nothing about a user is ever read here, and nothing read here
 * is ever presented as a user's own state.
 *
 * Like an own read, the answer carries when it was read, and a failure is
 * a state of its own, never an empty answer.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPublicClient, type PublicClient } from 'viem';
import { useAccount } from 'wagmi';
import { DEFAULT_CHAIN, getSupportedChain, type SupportedChain } from '../../chain/chains';
import { httpTransports } from '../../chain/wagmi';
import { ownRefreshIntervalMs } from './refreshPolicy';
import { useVisible } from './useVisible';

export interface ChainRead<T> {
  data: T | null;
  state: 'reading' | 'ready' | 'failed';
  error: string | null;
  readAt: number | null;
  refreshing: boolean;
  refetch: () => void;
}

/** The chain the screen describes: the wallet's, when served; else the default. */
export function useScreenChain(): SupportedChain {
  const { chainId } = useAccount();
  return getSupportedChain(chainId) ?? DEFAULT_CHAIN;
}

const clients = new Map<number, PublicClient>();
function clientFor(chain: SupportedChain): PublicClient {
  let c = clients.get(chain.chainId);
  if (!c) {
    c = createPublicClient({ transport: httpTransports(chain.rpcEndpoints) }) as PublicClient;
    clients.set(chain.chainId, c);
  }
  return c;
}

export function useChainRead<T>(
  parts: readonly unknown[],
  read: (client: PublicClient, chain: SupportedChain) => Promise<T>,
  opts: {
    /** Data that never changes for an address (a token's decimals) is read
     *  once; everything else refreshes on the own-state interval while the
     *  tab is visible (RB-REFRESH). */
    immutable?: boolean;
    enabled?: boolean;
  } = {},
): ChainRead<T> {
  const chain = useScreenChain();
  const visible = useVisible();
  const client = useMemo(() => clientFor(chain), [chain]);
  const query = useQuery({
    queryKey: ['chain', chain.chainId, ...parts],
    queryFn: () => read(client, chain),
    enabled: opts.enabled ?? true,
    staleTime: opts.immutable ? Infinity : 0,
    refetchInterval: opts.immutable ? false : ownRefreshIntervalMs(visible),
    refetchIntervalInBackground: false,
    retry: 1,
  });
  if (query.status === 'error' && query.data === undefined) {
    return { data: null, state: 'failed', error: (query.error as Error).message, readAt: null, refreshing: query.isFetching, refetch: () => void query.refetch() };
  }
  if (query.data === undefined) {
    return { data: null, state: 'reading', error: null, readAt: null, refreshing: true, refetch: () => void query.refetch() };
  }
  return {
    data: query.data,
    state: 'ready',
    error: query.status === 'error' ? (query.error as Error).message : null,
    readAt: query.dataUpdatedAt,
    refreshing: query.isFetching,
    refetch: () => void query.refetch(),
  };
}
