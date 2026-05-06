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

/** Periodic refetch cadence for `/offers/stats`. Exported so any UI that
 *  wants to render a "next refresh" countdown stays in lock-step with the
 *  actual fetch timer (no double source of truth). 30 s aligns with the
 *  `warm` watermark policy so both numbers in the diagnostics panel move
 *  on the same heartbeat. */
export const OFFER_STATS_REFETCH_MS = 30_000;

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
    // the IndexerStatusBadge / ChainDiagnosticsPanel block-space numbers
    // freeze when the chain is quiet (no `nextOfferId`/`nextLoanId`
    // advance to bump `version`) even though the watcher cron is ticking.
    // 30 s cadence (was 60 s) — locks in step with the `warm` watermark
    // probe so `Last safe block (indexed)` and `Chain safe head` move
    // on the same heartbeat. /offers/stats reads from D1 only, no chain
    // RPC quota burn. Exported via `OFFER_STATS_REFETCH_MS` so the
    // ChainDiagnosticsPanel can render an honest "Next refresh in: Ns"
    // countdown.
    const id = setInterval(() => {
      void tick();
    }, OFFER_STATS_REFETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [chainId, version]);

  return { stats, loading };
}
