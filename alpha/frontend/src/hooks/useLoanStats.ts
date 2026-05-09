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
  const [stats, setStats] = useState<LoanStats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const next = await fetchLoanStats(chainId);
      setStats(next);
    } catch {
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [chainId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const next = await fetchLoanStats(chainId);
        if (cancelled) return;
        setStats(next);
      } catch {
        if (cancelled) return;
        setStats(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId, version]);

  return { stats, loading, reload: load };
}
