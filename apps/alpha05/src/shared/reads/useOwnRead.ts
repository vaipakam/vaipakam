/**
 * An own-state read (RB-RAILS, RB-REFRESH): bound to the connected identity
 * and chain (`ownKey`), read through the wallet's provider first, refreshed
 * on signals (own receipt, push hint for the address, focus, reconnection)
 * and on the bounded interval while visible; per block when the read gates
 * an imminent money decision. The answer carries when it was read and which
 * transport answered, so a surface states both.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlockNumber } from 'wagmi';
import { useOwnStateClient, type OwnStateClient } from '../../chain/ownRail';
import { ownKey } from './identityKey';
import { ownRefreshIntervalMs } from './refreshPolicy';
import { matchesIdentity, subscribeOwnChanges } from './signals';

export interface OwnRead<T> {
  /** `null` until read, or when no wallet is connected on a supported chain. */
  data: T | null;
  /** Why there is no data: no identity, still reading, or the read failed. */
  state: 'no-identity' | 'reading' | 'ready' | 'failed';
  error: string | null;
  /** When the data was read (unix ms), null before the first answer. */
  readAt: number | null;
  /** Which transport answered first: the wallet's provider or the proxy. */
  via: 'wallet' | 'proxy' | null;
  /** Whether a refresh is in flight behind data already shown. */
  refreshing: boolean;
  refetch: () => void;
}

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

export function useOwnRead<T>(
  parts: readonly unknown[],
  read: (own: OwnStateClient) => Promise<T>,
  opts: { perBlock?: boolean; enabled?: boolean } = {},
): OwnRead<T> {
  const own = useOwnStateClient();
  const queryClient = useQueryClient();
  const visible = useVisible();
  const enabled = own !== null && (opts.enabled ?? true);
  const key = own ? ownKey({ chainId: own.chainId, account: own.account }, ...parts) : (['own', 'none', ...parts] as const);

  const query = useQuery({
    queryKey: key,
    queryFn: () => read(own!),
    enabled,
    refetchInterval: ownRefreshIntervalMs(visible),
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: 1,
  });

  // Signals: an own receipt or a push hint for this identity, a regained
  // connection, a tab becoming visible again.
  useEffect(() => {
    if (!own) return;
    const { chainId, account } = own;
    const refetch = () => void queryClient.invalidateQueries({ queryKey: ownKey({ chainId, account }) });
    const unsubscribe = subscribeOwnChanges((s) => {
      if (matchesIdentity(s, chainId, account)) refetch();
    });
    const onOnline = () => refetch();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refetch();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [own, queryClient]);

  // Per-block refresh for a read that gates an imminent money decision.
  const block = useBlockNumber({ chainId: own?.chainId, watch: Boolean(opts.perBlock && enabled && visible), query: { enabled: Boolean(opts.perBlock && enabled) } });
  const blockNumber = opts.perBlock ? block.data : undefined;
  useEffect(() => {
    if (blockNumber === undefined || !enabled) return;
    void query.refetch();
    // The query object changes identity on every render; the block number
    // is the signal, and refetch() is stable for the query's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockNumber, enabled]);

  if (!own) return { data: null, state: 'no-identity', error: null, readAt: null, via: null, refreshing: false, refetch: () => {} };
  const via = own.walletFirst ? 'wallet' : 'proxy';
  if (query.status === 'error' && query.data === undefined) {
    return { data: null, state: 'failed', error: (query.error as Error).message, readAt: null, via, refreshing: query.isFetching, refetch: () => void query.refetch() };
  }
  if (query.data === undefined) {
    return { data: null, state: 'reading', error: null, readAt: null, via, refreshing: true, refetch: () => void query.refetch() };
  }
  return {
    data: query.data,
    state: 'ready',
    error: query.status === 'error' ? (query.error as Error).message : null,
    readAt: query.dataUpdatedAt,
    via,
    refreshing: query.isFetching,
    refetch: () => void query.refetch(),
  };
}
