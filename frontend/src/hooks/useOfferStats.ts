/**
 * T-041 Phase 1+2 — homepage offer-book stats.
 *
 * Pulls aggregate counts (active / accepted / cancelled / total) from
 * the worker. Returns `null` while loading and on any error so the
 * homepage's hero card can collapse to its current "no live counts"
 * fallback rendering — the page still loads, the live ticker just
 * stays absent. No browser fallback for this one specifically: the
 * stats are aggregate-only and the caller can degrade gracefully
 * without a per-browser log-scan replicating what the worker does.
 */

import { useEffect, useState } from 'react';
import { fetchOfferStats, type OfferStats } from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';

interface UseOfferStatsResult {
  stats: OfferStats | null;
  loading: boolean;
}

const REFRESH_MS = 30_000;

export function useOfferStats(): UseOfferStatsResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const [stats, setStats] = useState<OfferStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const next = await fetchOfferStats(chainId);
      if (!cancelled) {
        setStats(next);
        setLoading(false);
      }
    }
    void tick();
    const interval = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [chainId]);

  return { stats, loading };
}
