import { useCallback, useEffect, useState } from 'react';
import { useProtocolStats } from './useProtocolStats';
import { AssetType, LoanStatus, type LoanDetails } from '../types/loan';

export type TimeRange = '24h' | '7d' | '30d' | '90d' | 'All';

export interface SeriesPoint {
  /** Unix-seconds at bucket start (midnight UTC for daily buckets). */
  t: number;
  /** Primary value: USD-priced principal volume or rolling TVL depending on series. */
  value: number;
  /** Secondary value: USD interest earned on the same loans attributed to this bucket. */
  secondary?: number;
}

export interface HistoricalSeries {
  /** Rolling cumulative TVL (USD) with interest cumulative on `secondary`. */
  tvl: SeriesPoint[];
  /** Per-day origination volume (USD) with lifetime interest on `secondary`. */
  dailyVolume: SeriesPoint[];
  activeVsCompleted: { active: number; completed: number; defaulted: number };
}

const RANGE_DAYS: Record<TimeRange, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  All: 365,
};

function startOfDayUnix(ts: number): number {
  const d = new Date(ts * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/**
 * Builds daily time series from the aggregated protocol-stats snapshot.
 * Each loan's `startTime` contributes to that day's USD-priced volume
 * bucket; lifetime interest earned on the same loan drops into the
 * bucket's `secondary`. A rolling cumulative is used for the TVL series.
 *
 * USD pricing reuses `stats.assetInfo` (oracle price + token decimals per
 * ERC-20 asset) so assets with different decimals (USDC 6d, WBTC 8d,
 * WETH 18d) are correctly normalized — prior versions used a hardcoded
 * 1e18 divisor that silently distorted non-18-decimal assets.
 *
 * Non-ERC20 (rental) loans have no USD price and are excluded from the
 * USD time series to keep axes meaningful.
 *
 * This is a rough approximation — a production-grade TVL-over-time series
 * would reconstruct exact add/remove events at block height; Phase 1 is
 * deliberately simple and free of archive-node reads.
 */
export function useHistoricalData(range: TimeRange = '30d') {
  const { stats, loading, error } = useProtocolStats();
  const [series, setSeries] = useState<HistoricalSeries | null>(null);

  const build = useCallback(() => {
    if (!stats) return;
    const now = Math.floor(Date.now() / 1000);
    const windowSec = RANGE_DAYS[range] * 86400;
    const from = now - windowSec;

    const dailyVolBuckets = new Map<number, number>();
    const dailyInterestBuckets = new Map<number, number>();
    let active = 0;
    let completed = 0;
    let defaulted = 0;

    for (const loan of stats.loans as LoanDetails[]) {
      const start = Number(loan.startTime);
      const status = Number(loan.status);
      if (status === LoanStatus.Active || status === LoanStatus.FallbackPending) active += 1;
      else if (status === LoanStatus.Defaulted) {
        defaulted += 1;
        completed += 1;
      } else completed += 1;

      if (start < from) continue;
      if (Number(loan.assetType) !== AssetType.ERC20) continue;

      const info = stats.assetInfo[loan.principalAsset.toLowerCase()];
      if (!info || info.price === 0n) continue;

      const priceScaled = Number(info.price) / 10 ** info.priceDecimals;
      const tokenScaled = Number(loan.principal) / 10 ** info.tokenDecimals;
      const usd = priceScaled * tokenScaled;
      if (usd === 0) continue;

      const day = startOfDayUnix(start);
      dailyVolBuckets.set(day, (dailyVolBuckets.get(day) ?? 0) + usd);
      const interestUsd = (usd * Number(loan.interestRateBps)) / 10000;
      dailyInterestBuckets.set(day, (dailyInterestBuckets.get(day) ?? 0) + interestUsd);
    }

    const dailyVolume: SeriesPoint[] = Array.from(dailyVolBuckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, value]) => ({ t, value, secondary: dailyInterestBuckets.get(t) ?? 0 }));

    let runningVol = 0;
    let runningInterest = 0;
    const tvl: SeriesPoint[] = dailyVolume.map(({ t, value, secondary }) => {
      runningVol += value;
      runningInterest += secondary ?? 0;
      return { t, value: runningVol, secondary: runningInterest };
    });

    setSeries({
      tvl,
      dailyVolume,
      activeVsCompleted: { active, completed, defaulted },
    });
  }, [stats, range]);

  useEffect(() => {
    build();
  }, [build]);

  return { series, loading, error };
}
