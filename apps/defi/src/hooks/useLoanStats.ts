import { useEffect, useState, useCallback } from 'react';
import { fetchLoanStats, type LoanStats } from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';

interface UseLoanStatsResult {
  stats: LoanStats | null;
  loading: boolean;
  /** Imperative trigger — re-runs the indexer fetch even when none of
   *  the watermark-driven deps changed (manual rescan button). */
  reload: () => Promise<void>;
}

/**
 * Indexer-first protocol-wide loan aggregates: counts per status,
 * ERC-20 vs NFT-rental split, per-asset principal volume, and APR
 * average.
 *
 * Backed by `/loans/stats` on the worker, which runs the
 * aggregation as O(table-scan) D1 queries — replaces the
 * Analytics page's previous per-loan `getLoanDetails` multicall
 * storm (which scaled linearly with protocol history) with one
 * HTTP call. Cool-tier auto-refresh: 180 s active, 600 s idle,
 * pause @ 15 min walked-away. Aggregate metrics move slowly so
 * sub-minute refresh would be theatre.
 *
 * Returns `stats: null` when the worker is unreachable. Callers
 * decide between (a) showing an "indexer offline" placeholder, or
 * (b) falling back to a separate hook that reads from chain. The
 * Analytics page chooses (a) — these aggregates aren't load-bearing
 * for any user-funds flow, only for cards / charts.
 */
export function useLoanStats(): UseLoanStatsResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const { version } = useLiveWatermark(watermarkPolicy('cool'));
  // Tagged with the chain the aggregates describe. `loading` is DERIVED, so a
  // chain switch cannot render one network's loan totals under another's name
  // for a frame. `version` is NOT part of the key: a watermark tick asks the
  // same question hoping for a fresher answer, and treating it as a new
  // question would blank the charts on every tick.
  const [result, setResult] = useState<{ chainId: number; stats: LoanStats | null } | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await fetchLoanStats(chainId).catch(() => null);
      setResult({ chainId, stats: next });
    } finally {
      setRefreshing(false);
    }
  }, [chainId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await fetchLoanStats(chainId).catch(() => null);
      if (cancelled) return;
      setResult({ chainId, stats: next });
    })();
    return () => {
      cancelled = true;
    };
    // `version` re-runs the fetch without invalidating the current answer —
    // see the note on the key above.
  }, [chainId, version]);

  const matched = result?.chainId === chainId;
  return {
    stats: matched ? result.stats : null,
    // An explicit `reload()` reports loading even though the question is
    // unchanged; it is called from handlers, never from an effect.
    loading: refreshing || !matched,
    reload: load,
  };
}
