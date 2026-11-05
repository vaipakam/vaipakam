import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { indexerOrigin } from '../../../chain/endpoints';
import { DEFAULT_CHAIN, getSupportedChain } from '../../../chain/chains';
import { announceOwnChange } from '../signals';
import { worldKey } from '../identityKey';
import { createIndexerClient, type IndexerClient } from './indexerClient';
import { freshnessOf, withCursor, type Freshness, type IngestHealth } from './ingestHealth';
import { invalidationsFor, openPushRail, pushRailUrl, type PushState } from './pushRail';

/** How often the index's freshness is polled while the tab is visible. The
 *  push rail's `cursor` frames advance the stamp between polls. */
export const HEALTH_POLL_MS = 60_000;

export interface WorldRail {
  indexer: IndexerClient;
  /** The chain the rail describes (the wallet's, else the default). */
  chainId: number;
  freshness: Freshness;
  push: { state: PushState; lastFrameAt: number | null };
  /** Re-read the index's freshness now. */
  refresh: () => void;
}

const WorldRailContext = createContext<WorldRail | null>(null);

/** One indexer client per build. */
const INDEXER = createIndexerClient(indexerOrigin(import.meta.env));

export function WorldRailProvider({ children }: { children: ReactNode }) {
  const { chainId: walletChainId, address } = useAccount();
  const chain = getSupportedChain(walletChainId) ?? DEFAULT_CHAIN;
  const queryClient = useQueryClient();
  const account = address ?? null;

  const health = useQuery({
    queryKey: worldKey(chain.chainId, 'ingestHealth'),
    queryFn: () => INDEXER.getJson<IngestHealth>('/health/ingest'),
    enabled: INDEXER.origin !== null,
    refetchInterval: HEALTH_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: HEALTH_POLL_MS / 2,
    retry: false,
  });

  // A one-minute tick so the age shown keeps counting between polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const [push, setPush] = useState<{ chainId: number; state: PushState; lastFrameAt: number | null; cursor: { lastBlock: number; updatedAt: number } | null }>({
    chainId: chain.chainId,
    state: INDEXER.origin === null ? 'off' : 'connecting',
    lastFrameAt: null,
    cursor: null,
  });

  useEffect(() => {
    const url = pushRailUrl(INDEXER.origin, chain.chainId);
    if (url === null) return;
    const chainId = chain.chainId;
    const handle = openPushRail({
      url,
      onState: (state) => setPush((p) => (p.chainId === chainId ? { ...p, state } : { chainId, state, lastFrameAt: null, cursor: null })),
      onFrame: (frame) => {
        const at = Date.now();
        const cursor =
          frame.t === 'cursor'
            ? { lastBlock: Number(frame.lastBlock), updatedAt: frame.updatedAt }
            : frame.t === 'hello'
              ? frame.cursor
              : null;
        setPush((p) => ({ chainId, state: p.chainId === chainId ? p.state : 'live', lastFrameAt: at, cursor: cursor ?? (p.chainId === chainId ? p.cursor : null) }));
        const what = invalidationsFor(frame, account);
        if (what.world) void queryClient.invalidateQueries({ queryKey: worldKey(chainId) });
        if (what.own && account) announceOwnChange({ chainId, account, cause: 'push' });
      },
    });
    return () => handle.close();
  }, [chain.chainId, account, queryClient]);

  const value = useMemo<WorldRail>(() => {
    const elapsedSec = health.dataUpdatedAt ? Math.max(0, (nowMs - health.dataUpdatedAt) / 1000) : 0;
    const error = INDEXER.origin === null ? 'This build has no indexer origin.' : health.error ? health.error.message : null;
    const polled = freshnessOf({ health: health.data ?? null, error, chainId: chain.chainId, diamond: chain.diamondAddress, elapsedSec });
    const pushForChain = push.chainId === chain.chainId ? push : null;
    return {
      indexer: INDEXER,
      chainId: chain.chainId,
      freshness: withCursor(polled, pushForChain?.cursor ?? null, nowMs / 1000),
      push: { state: pushForChain?.state ?? (INDEXER.origin === null ? 'off' : 'connecting'), lastFrameAt: pushForChain?.lastFrameAt ?? null },
      refresh: () => void health.refetch(),
    };
  }, [health, nowMs, chain.chainId, chain.diamondAddress, push]);

  return <WorldRailContext.Provider value={value}>{children}</WorldRailContext.Provider>;
}

export function useWorldRail(): WorldRail {
  const ctx = useContext(WorldRailContext);
  if (!ctx) throw new Error('useWorldRail outside WorldRailProvider');
  return ctx;
}
