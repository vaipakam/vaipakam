import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { useDiamondRead } from '../contracts/useDiamond';
import { beginStep } from '../lib/journeyLog';

const STALE_MS = 5 * 60_000; // 5 min — historical snapshots don't move once captured.

/**
 * On-chain reader for the daily price-snapshot ring buffer
 * `s.assetPriceSnapshots[asset][dayIndex]` populated by
 * `OracleFacet.captureDailyPriceSnapshot` once per UTC day per
 * chain. AnalyticalGettersDesign §3.4 / D11.
 *
 * Use cases:
 *  - Historical-TVL chart (eventually): price each day's totals
 *    at THAT day's price rather than today's.
 *  - Audit / forensics surface: "what was X's reported price on
 *    block 12,345,678?"
 *  - Any UI showing a backward-looking price chart.
 *
 * Returns the zero struct (`capturedAt == 0`) for never-captured
 * days. Consumers should treat zero as "no snapshot yet" and
 * either fall back to live `getAssetPrice` (current price) or
 * skip rendering for that day.
 *
 * Per-day snapshots are immutable once captured, so the cache TTL
 * is 5 min — the only refresh path is a brand-new day rolling
 * over.
 */
export interface AssetPriceSnapshot {
  price: bigint;
  feedDecimals: number;
  capturedAt: bigint;
}

interface CacheKey {
  asset: string;
  dayIndex: number;
}
const cache = new Map<string, { data: AssetPriceSnapshot; at: number }>();
const keyOf = (k: CacheKey) => `${k.asset}:${k.dayIndex}`;

export function useHistoricalAssetPrice(
  asset: Address | null,
  dayIndex: number | null,
) {
  const diamond = useDiamondRead();
  const cacheKey =
    asset && dayIndex !== null
      ? keyOf({ asset: asset.toLowerCase(), dayIndex })
      : '';
  const [snapshot, setSnapshot] = useState<AssetPriceSnapshot | null>(
    cache.get(cacheKey)?.data ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!asset || dayIndex === null) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < STALE_MS) {
      setSnapshot(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const step = beginStep({
      area: 'oracle',
      flow: 'useHistoricalAssetPrice',
      step: `getHistoricalAssetPrice(${asset.slice(0, 8)}, ${dayIndex})`,
    });
    try {
      const raw = await (
        diamond as unknown as {
          getHistoricalAssetPrice: (
            a: Address,
            d: number,
          ) => Promise<{
            price: bigint;
            feedDecimals: number;
            capturedAt: bigint;
          }>;
        }
      ).getHistoricalAssetPrice(asset, dayIndex);
      const next: AssetPriceSnapshot = {
        price: BigInt(raw.price ?? 0),
        feedDecimals: Number(raw.feedDecimals ?? 0),
        capturedAt: BigInt(raw.capturedAt ?? 0),
      };
      cache.set(cacheKey, { data: next, at: Date.now() });
      setSnapshot(next);
      step.success({
        note:
          next.capturedAt > 0n
            ? `price=${next.price} dec=${next.feedDecimals}`
            : 'never captured',
      });
    } catch (err) {
      setError(err as Error);
      step.failure(err);
    } finally {
      setLoading(false);
    }
  }, [diamond, asset, dayIndex, cacheKey]);

  useEffect(() => {
    load();
  }, [load]);

  const reload = useCallback(async () => {
    cache.delete(cacheKey);
    await load();
  }, [load, cacheKey]);

  return { snapshot, loading, error, reload };
}

/** Test-only — wipes the per-day cache. */
export function __clearHistoricalAssetPriceCache() {
  cache.clear();
}
