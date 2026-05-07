import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondPublicClient, useReadChain } from '../contracts/useDiamond';
import { DEFAULT_CHAIN } from '../contracts/config';
import { DIAMOND_ABI_VIEM as DIAMOND_ABI } from '@vaipakam/contracts/abis';
import { batchCalls, encodeBatchCalls } from '../lib/multicall';
import { fetchTokenMeta } from '../lib/tokenMeta';
import {
  fetchLoanTimeseries,
  type LoanTimeseriesRange,
} from '../lib/indexerClient';
import { useProtocolStats } from './useProtocolStats';
import { useLoanStats } from './useLoanStats';
import { useLiveWatermark } from './useLiveWatermark';
import { watermarkPolicy } from './watermarkPolicy';
import { AssetType, LoanStatus, type LoanDetails } from '../types/loan';

export type TimeRange = LoanTimeseriesRange;

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
 * Builds the Analytics page's "TVL Over Time" + "Daily Loan Volume"
 * + "Active vs Completed" charts.
 *
 * Indexer-first: pulls per-asset BigInt buckets from
 * `/loans/timeseries?range=...` and prices them client-side via the
 * oracle (`getAssetPrice`) over the unique asset set — same shape
 * as `useAssetBreakdown`. Cost shape:
 *
 *   - One worker call returning pre-bucketed BigInt sums by asset.
 *   - One on-chain `getAssetPrice` multicall over UNIQUE assets in
 *     the response (typically <10, scales with the protocol's
 *     supported-token set).
 *   - Per-asset `fetchTokenMeta` for symbol + decimals — the
 *     localStorage-backed cache makes repeat visits free.
 *
 * Pre-refactor, this hook walked `useProtocolStats.loans` (the
 * full multicall'd loan list) and bucketed in JS. That multicall
 * scaled linearly with protocol history; this version scales with
 * the unique-asset set.
 *
 * Active / completed / defaulted counts come from `useLoanStats`
 * (also indexer-first), with `useProtocolStats` as the worker-down
 * fallback to keep the chart honest during outages.
 */
export function useHistoricalData(range: TimeRange = '30d') {
  const publicClient = useDiamondPublicClient();
  const chain = useReadChain();
  const chainId = chain.chainId ?? DEFAULT_CHAIN.chainId;
  const diamondAddress = (chain.diamondAddress ??
    DEFAULT_CHAIN.diamondAddress) as Address;
  // Indexer-failure tracker — flips to true the first time
  // `fetchLoanTimeseries` returns null (worker offline). Drives
  // the `useProtocolStats({ enabled })` gate so the chain-side
  // fallback only fires when the indexer is confirmed-unreachable.
  // Cleared back to false on the next successful indexer fetch.
  const [indexerFailed, setIndexerFailed] = useState(false);
  const { stats, loading: statsLoading, error: statsError } = useProtocolStats({
    enabled: indexerFailed,
  });
  const { stats: loanStats } = useLoanStats();
  // Cool-tier auto-refresh — historical aggregates move slowly.
  const { version: watermarkVersion } = useLiveWatermark(watermarkPolicy('cool'));
  const [series, setSeries] = useState<HistoricalSeries | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Active / completed / defaulted counts. Prefer loanStats
      // (indexer-fresh) when available; else derive from the chain-
      // -derived stats.loans walk.
      let activeVsCompleted: HistoricalSeries['activeVsCompleted'];
      if (loanStats) {
        activeVsCompleted = {
          active: loanStats.active,
          completed: loanStats.repaid + loanStats.settled,
          defaulted: loanStats.defaulted + loanStats.liquidated,
        };
      } else if (stats) {
        let active = 0;
        let completed = 0;
        let defaulted = 0;
        for (const loan of stats.loans as LoanDetails[]) {
          const status = Number(loan.status);
          if (status === LoanStatus.Active || status === LoanStatus.FallbackPending)
            active += 1;
          else if (status === LoanStatus.Defaulted) {
            defaulted += 1;
            completed += 1;
          } else completed += 1;
        }
        activeVsCompleted = { active, completed, defaulted };
      } else {
        return;
      }

      // ── Indexer-first bucket walk ──
      const ts = await fetchLoanTimeseries(chainId, range);
      if (cancelled) return;
      if (ts) {
        // Worker healthy — release the chain-side fallback gate.
        setIndexerFailed(false);
        // Collect every asset that shows up in any bucket → unique
        // set for the price multicall + meta fetch. Defensive
        // shape filter: drop any malformed-address keys (`"0x"`
        // etc.) — viem's `getAssetPrice` encoder throws
        // `InvalidAddressError` on non-20-byte hex, which would
        // poison the whole multicall batch. The server's
        // timeseries write filters too but old rows can still
        // surface bad-shape keys.
        const assetSet = new Set<string>();
        for (const b of ts.buckets) {
          for (const a of Object.keys(b.principalByAsset)) {
            if (typeof a === 'string' && a.length === 42 && a.startsWith('0x')) {
              assetSet.add(a);
            }
          }
        }
        const assets = Array.from(assetSet);

        // Empty-result short-circuit: no loans in the window means
        // no buckets to render. Still surface the active/completed
        // counts so the donut renders.
        if (assets.length === 0) {
          if (!cancelled)
            setSeries({ tvl: [], dailyVolume: [], activeVsCompleted });
          return;
        }

        // Oracle prices + token meta for the unique asset set —
        // bounded chain reads. Same shape as `useAssetBreakdown`.
        const priceCalls = encodeBatchCalls(
          diamondAddress,
          DIAMOND_ABI,
          'getAssetPrice',
          assets.map((a) => [a as Address] as const),
        );
        const priceResults = await batchCalls<[bigint, number]>(
          publicClient,
          DIAMOND_ABI,
          'getAssetPrice',
          priceCalls,
        );
        if (cancelled) return;
        const meta = await Promise.all(
          assets.map(async (a) => {
            try {
              const m = await fetchTokenMeta(a, publicClient);
              return { symbol: m.symbol, decimals: m.decimals };
            } catch {
              return { symbol: a.slice(0, 6) + '…', decimals: 18 };
            }
          }),
        );
        if (cancelled) return;
        const priceByAsset = new Map<
          string,
          { price: bigint; priceDecimals: number; tokenDecimals: number }
        >();
        assets.forEach((a, i) => {
          const r = priceResults[i];
          const m = meta[i];
          if (!r || (r[0] ?? 0n) === 0n) return;
          priceByAsset.set(a, {
            price: r[0] as bigint,
            priceDecimals: Number(r[1] ?? 8),
            tokenDecimals: m.decimals,
          });
        });

        // Roll the per-asset BigInt buckets into per-day USD totals.
        // BigInt → Number happens after USD conversion to keep the
        // precision loss bounded by the price scaling, not the raw
        // 18-decimal token magnitudes.
        const dailyVolume: SeriesPoint[] = ts.buckets.map((b) => {
          let usd = 0;
          let interestUsd = 0;
          for (const [asset, principalStr] of Object.entries(b.principalByAsset)) {
            const info = priceByAsset.get(asset);
            if (!info) continue;
            const priceScaled = Number(info.price) / 10 ** info.priceDecimals;
            try {
              const tokenScaled =
                Number(BigInt(principalStr)) / 10 ** info.tokenDecimals;
              usd += priceScaled * tokenScaled;
            } catch {
              // Skip malformed BigInt strings.
            }
          }
          for (const [asset, interestStr] of Object.entries(b.interestByAsset)) {
            const info = priceByAsset.get(asset);
            if (!info) continue;
            const priceScaled = Number(info.price) / 10 ** info.priceDecimals;
            try {
              const tokenScaled =
                Number(BigInt(interestStr)) / 10 ** info.tokenDecimals;
              interestUsd += priceScaled * tokenScaled;
            } catch {
              // Skip malformed BigInt strings.
            }
          }
          return { t: b.t, value: usd, secondary: interestUsd };
        });

        let runningVol = 0;
        let runningInterest = 0;
        const tvl: SeriesPoint[] = dailyVolume.map(({ t, value, secondary }) => {
          runningVol += value;
          runningInterest += secondary ?? 0;
          return { t, value: runningVol, secondary: runningInterest };
        });

        if (!cancelled) {
          setSeries({ tvl, dailyVolume, activeVsCompleted });
        }
        return;
      }

      // ── Chain-side fallback (worker unreachable) ──
      // Walk the multicall'd loans list bucket-by-bucket the same
      // way the pre-refactor hook did. Lower throughput but
      // correctness preserved during a worker outage. Flip the
      // gate flag so `useProtocolStats` activates if it isn't
      // already running.
      setIndexerFailed(true);
      if (!stats) return;
      const now = Math.floor(Date.now() / 1000);
      const windowSec = RANGE_DAYS[range] * 86400;
      const from = now - windowSec;
      const dailyVolBuckets = new Map<number, number>();
      const dailyInterestBuckets = new Map<number, number>();
      for (const loan of stats.loans as LoanDetails[]) {
        const start = Number(loan.startTime);
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
        const interestUsd = (usd * Number(loan.interestRateBps)) / 10_000;
        dailyInterestBuckets.set(
          day,
          (dailyInterestBuckets.get(day) ?? 0) + interestUsd,
        );
      }
      const dailyVolume: SeriesPoint[] = Array.from(dailyVolBuckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([t, value]) => ({
          t,
          value,
          secondary: dailyInterestBuckets.get(t) ?? 0,
        }));
      let runningVol = 0;
      let runningInterest = 0;
      const tvl: SeriesPoint[] = dailyVolume.map(({ t, value, secondary }) => {
        runningVol += value;
        runningInterest += secondary ?? 0;
        return { t, value: runningVol, secondary: runningInterest };
      });
      if (!cancelled) setSeries({ tvl, dailyVolume, activeVsCompleted });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    chainId,
    diamondAddress,
    publicClient,
    range,
    loanStats,
    stats,
    watermarkVersion,
  ]);

  return { series, loading: statsLoading, error: statsError };
}
