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

interface UseOfferStatsResult {
  stats: OfferStats | null;
  loading: boolean;
}

export function useOfferStats(): UseOfferStatsResult {
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const { version } = useLiveWatermark();
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
    return () => {
      cancelled = true;
    };
  }, [chainId, version]);

  return { stats, loading };
}
