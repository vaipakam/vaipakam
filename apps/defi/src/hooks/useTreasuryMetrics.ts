import { useCallback, useEffect, useState } from 'react';
import { useDiamondRead } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const NUMERAIRE_SCALE = 1e18;
const STALE_MS = 30_000;

export interface TreasuryMetrics {
  /** Live numeraire-quoted balance of unclaimed fees still held at the
   *  Diamond. The numeraire is whatever governance has configured (USD by
   *  post-deploy default; rotatable to EUR/JPY/XAU). */
  treasuryBalanceNumeraire: number;
  /** Lifetime cumulative fees accrued, frozen in the active numeraire at
   *  the moment of accrual. */
  totalFeesCollectedNumeraire: number;
  /** Fees accrued in the last 24 hours, in the active numeraire at accrual time. */
  feesLast24hNumeraire: number;
  /** Fees accrued in the last 7 days, in the active numeraire at accrual time. */
  feesLast7dNumeraire: number;
  fetchedAt: number;
}

let cached: { data: TreasuryMetrics; at: number } | null = null;

/**
 * Reads the protocol-wide treasury/revenue snapshot from MetricsFacet.
 * The numeraire-quoted figures are denominated in 1e18 on-chain; we
 * normalize to native JS numbers for chart/display. Rolling-window
 * values are frozen at accrual time, so they are NOT revalued against
 * today's oracle prices.
 */
export function useTreasuryMetrics() {
  const diamond = useDiamondRead();
  const [metrics, setMetrics] = useState<TreasuryMetrics | null>(cached?.data ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (cached && Date.now() - cached.at < STALE_MS) {
      setMetrics(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({ area: 'dashboard', flow: 'useTreasuryMetrics', step: 'getTreasuryMetrics' });
    try {
      const [balance, total, last24h, last7d] = await (
        diamond as unknown as {
          getTreasuryMetrics: () => Promise<[bigint, bigint, bigint, bigint]>;
        }
      ).getTreasuryMetrics();
      const next: TreasuryMetrics = {
        treasuryBalanceNumeraire: Number(balance) / NUMERAIRE_SCALE,
        totalFeesCollectedNumeraire: Number(total) / NUMERAIRE_SCALE,
        feesLast24hNumeraire: Number(last24h) / NUMERAIRE_SCALE,
        feesLast7dNumeraire: Number(last7d) / NUMERAIRE_SCALE,
        fetchedAt: Date.now(),
      };
      cached = { data: next, at: Date.now() };
      setMetrics(next);
      step.success({ note: `treasury ${next.treasuryBalanceNumeraire.toFixed(2)} / lifetime ${next.totalFeesCollectedNumeraire.toFixed(2)}` });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cached = null;
    await load();
  }, [load]);

  return { metrics, loading, error, reload };
}

/** Test-only: wipe the module-scoped cache. */
export function __clearTreasuryMetricsCache() {
  cached = null;
}
