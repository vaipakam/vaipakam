/**
 * Pure math for the Rate Desk executed-rate chart (#1130) — kept
 * hook-free so the §5.3 honesty rules are unit-testable without
 * mounting the canvas component.
 */
import type {
  CandleInterval,
  CandleRange,
  RateCandleBucket,
} from '../data/indexer';

/** Client-side mirror of the worker's interval enum (bucket width in
 *  seconds) — keyed on the closed `CandleInterval` union, so the
 *  lookup is compile-time exhaustive, never a raw-string probe. */
export const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

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

/**
 * Which empty-state copy an empty bucket array earns (Codex #1139
 * round-1 P3): "this market never filled" is only claimable when the
 * evidence actually covers the market's whole history —
 *
 *  - `range === 'all'`: the empty series IS the whole history → market
 *    copy.
 *  - narrower range + the tape (the market's newest fills, all-time) is
 *    a CONFIRMED empty array → no fill exists anywhere → market copy.
 *  - otherwise (tape unavailable/loading, or tape holds older fills the
 *    range excludes) → range-scoped copy. Saying "no fills yet" here
 *    would misstate history and contradict the last-fill header.
 */
export function chartEmptyKind(
  range: CandleRange,
  tape: readonly unknown[] | null | undefined,
): 'market' | 'range' {
  if (range === 'all') return 'market';
  if (Array.isArray(tape) && tape.length === 0) return 'market';
  return 'range';
}

/** The tape fields the sparse-mode per-fill markers need — a subset of
 *  the data layer's IndexedLoan (kept structural so this module stays
 *  hook- and fetch-free). */
export interface TapeFillLike {
  loanId: number;
  startAt: number; // unix seconds — exact fill time
  interestRateBps: number;
  principal: string; // decimal string, lending-asset base units
}

/** One plotted point in sparse mode: an individual fill at its EXACT
 *  time. `fills > 1` only when prints share the same second — two
 *  points can't occupy one x-coordinate, so physically-coincident
 *  fills collapse into one marker that still carries the ×N count. */
export interface FillPoint {
  t: number; // exact fill time, unix seconds
  rateBps: number; // last same-second fill's rate (loan-id order)
  fills: number;
  principalTotal: string; // BigInt-folded decimal string
}

/**
 * Whether the tape rows FULLY cover the loaded buckets' fills (Codex
 * #1139 round-1 P2 on marker honesty): per-fill markers may only be
 * drawn from the tape when every fill the candle response folded is
 * present in the tape slice. Coverage is judged by exact count
 * equality — a tape row belongs to a bucket when its floored start
 * lands on an EMITTED bucket's t, and the in-bucket row count must
 * equal the buckets' fill total. Any mismatch (truncated tape walk,
 * 60 s candle-cache skew, scope drift between the two routes) fails
 * closed to the bucket-marker fallback — markers are never fabricated
 * or silently dropped.
 */
export function tapeCoversSparseFills(
  buckets: readonly RateCandleBucket[],
  tapeRows: readonly TapeFillLike[],
  intervalSec: number,
): boolean {
  const bucketStarts = new Set(buckets.map((b) => b.t));
  let inBuckets = 0;
  for (const row of tapeRows) {
    const t = Math.floor(row.startAt / intervalSec) * intervalSec;
    if (bucketStarts.has(t)) inBuckets += 1;
  }
  return inBuckets === totalFills(buckets);
}

/**
 * Sparse-mode per-fill points from the tape, or `null` when the tape
 * can't honestly stand in (no coverage per `tapeCoversSparseFills`, or
 * an unparsable principal). Points are the tape rows that fall inside
 * the emitted buckets, sorted chronologically with the loan-id
 * tiebreak (on-chain execution order — same rule as the worker's
 * fold), grouped ONLY by exact same-second collision.
 */
export function fillPointsFromTape(
  buckets: readonly RateCandleBucket[],
  tapeRows: readonly TapeFillLike[],
  intervalSec: number,
): FillPoint[] | null {
  if (buckets.length === 0) return null;
  if (!tapeCoversSparseFills(buckets, tapeRows, intervalSec)) return null;
  const bucketStarts = new Set(buckets.map((b) => b.t));
  const inRange = tapeRows
    .filter((r) =>
      bucketStarts.has(Math.floor(r.startAt / intervalSec) * intervalSec),
    )
    .sort((x, y) => x.startAt - y.startAt || x.loanId - y.loanId);
  const points: FillPoint[] = [];
  for (const row of inRange) {
    let principal: bigint;
    try {
      principal = BigInt(row.principal || '0');
    } catch {
      // The coverage count said this row was folded, but its principal
      // doesn't parse — the two sources disagree; fail closed.
      return null;
    }
    const last = points[points.length - 1];
    if (last !== undefined && last.t === row.startAt) {
      last.rateBps = row.interestRateBps; // chronological — last wins
      last.fills += 1;
      last.principalTotal = (
        BigInt(last.principalTotal) + principal
      ).toString();
    } else {
      points.push({
        t: row.startAt,
        rateBps: row.interestRateBps,
        fills: 1,
        principalTotal: principal.toString(),
      });
    }
  }
  return points;
}
