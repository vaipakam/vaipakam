/**
 * Pure math for the Rate Desk executed-rate chart (#1130) — kept
 * hook-free so the §5.3 honesty rules are unit-testable without
 * mounting the canvas component.
 */
import type { RateCandleBucket } from '../data/indexer';

/** Below this many fills in the loaded range the chart drops from
 *  candles to a step-line + per-fill markers ("sparse tape" mode,
 *  §5.3 rule 2) — OHLC shapes drawn from a handful of prints would be
 *  theatre, not signal. */
export const SPARSE_FILLS_THRESHOLD = 10;

/** Total executed fills across the loaded buckets. */
export function totalFills(buckets: readonly RateCandleBucket[]): number {
  return buckets.reduce((sum, b) => sum + b.fills, 0);
}

/** §5.3 rule 2 — candles only once the range holds enough fills. */
export function isSparseTape(buckets: readonly RateCandleBucket[]): boolean {
  return totalFills(buckets) < SPARSE_FILLS_THRESHOLD;
}

export interface LastPrint {
  rateBps: number;
  /** Unix seconds. Bucket-derived prints carry the bucket START time
   *  (the finest truth the aggregate offers); tape-derived prints
   *  carry the fill's exact timestamp. */
  at: number;
  source: 'bucket' | 'tape';
}

/**
 * The newest executed print for the header's "last fill: X.XX% · age"
 * line (§5.3 rule 5 — this REPLACES a %-change ticker, it never joins
 * one). Prefers the tape's newest fill when it is at least as fresh as
 * the newest bucket: the tape carries the exact fill time, and a fill
 * that just landed may not have been folded into the (60 s-cached)
 * candle response yet.
 */
export function newestPrint(
  buckets: readonly RateCandleBucket[],
  tapeNewest: { rateBps: number; at: number } | null,
): LastPrint | null {
  const last = buckets.length > 0 ? buckets[buckets.length - 1] : null;
  if (tapeNewest && (last === null || tapeNewest.at >= last.t)) {
    return { rateBps: tapeNewest.rateBps, at: tapeNewest.at, source: 'tape' };
  }
  if (last === null) return null;
  return { rateBps: last.close, at: last.t, source: 'bucket' };
}
