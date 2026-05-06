/**
 * Homepage offer-book stats fetcher, wired through the live-tail
 * pattern.
 *
 * Refetches when:
 *   - mount / chain change (initial snapshot)
 *   - tab returns to focus (visibilitychange listener inside
 *     `useLiveWatermark`)
 *   - the watermark probe sees `nextOfferId` or `nextLoanId` advance
 *     (i.e. someone created an offer or a loan landed anywhere on
 *     the chain — a strong signal the aggregate counts are stale)
 *
 * Stats are aggregate-only (no per-row data), so there's no RPC
 * catch-up step here — we just retrigger the indexer hit. The catch-up
 * primitives are used by the heavier list hooks
 * (`useIndexedActiveOffers`, etc.).
 */

import { useEffect, useState } from 'react';
import { fetchOfferStats, type OfferStats } from '../lib/indexerClient';
import { useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';

interface UseOfferStatsResult {
  stats: OfferStats | null;
  loading: boolean;
}

export function useOfferStats(): UseOfferStatsResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  // Stats are aggregate counters; 20 s probe is enough for the
  // homepage hero / dashboard cards. Saves 60 % of the RPC budget vs
  // the OfferBook's 5 s cadence.
  const { version } = useLiveWatermark(watermarkPolicy('warm'));
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
    // Periodic refetch independent of `version` advances. Without this
    // the popover's "cache age" stays frozen at first-paint when the
    // chain is quiet (no `nextOfferId`/`nextLoanId` advance to bump
    // `version`), even though the watcher cron is ticking every minute.
    // 60 s cadence keeps the cache-age label honest. Reads from D1 via
    // `/offers/stats`, not chain RPC — no quota concern.
    const id = setInterval(() => {
      void tick();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [chainId, version]);

  return { stats, loading };
}
