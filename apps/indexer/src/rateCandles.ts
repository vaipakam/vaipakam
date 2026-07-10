/**
 * Rate Desk phase 2 (#1130) — pure executed-rate candle folding for
 * `GET /loans/rate-candles` (ProRateTerminalDesign.md §7).
 *
 * Side-effect-free (no Env, no D1) so the bucket-boundary / OHLC-ordering /
 * BigInt-principal math is unit-testable under the existing node-environment
 * vitest setup — same split as `webhookAuth.ts` / `invalidationKeysFromResult`.
 *
 * Why the fold is in JS and not SQL:
 *   - `principalTotal` MUST NOT be SQL-SUMmed: `loans.principal` is a decimal
 *     STRING because 18-dec wei amounts overflow SQLite's 64-bit integers —
 *     the same reason `/loans/stats` folds with JS BigInt (loanRoutes.ts).
 *   - `open`/`close` need the chronologically first/last rate per bucket, and
 *     SQLite has no FIRST_VALUE-style aggregate inside GROUP BY — emulating it
 *     needs correlated subqueries or window-function gymnastics per bucket.
 *   Since the rows must be selected anyway for the principal fold, folding the
 *   (small-integer) rates and counts in the same single pass is the simplest
 *   correct approach; splitting OHLC into SQL would add a second query shape
 *   for zero gain at any realistic per-market row count.
 */

/** Allowed `interval` values → bucket width in seconds. */
export const CANDLE_INTERVALS: Record<string, number> = {
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

/** Allowed `range` values → lookback in days (null = no lower time bound). */
export const CANDLE_RANGES: Record<string, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
};

/** The columns the candle SQL selects per fill. */
export interface CandleFillRow {
  loan_id: number;
  start_at: number; // unix seconds — the loan's start timestamp
  interest_rate_bps: number;
  principal: string; // decimal string, raw base units of the lending asset
}

export interface RateCandleBucket {
  t: number; // bucket start, unix seconds
  open: number; // first fill's rate (bps) in the bucket, chronological
  high: number;
  low: number;
  close: number; // last fill's rate (bps) in the bucket, chronological
  fills: number;
  principalTotal: string; // BigInt-folded decimal string (never a JSON number)
}

/**
 * Fold executed fills into OHLC buckets of `intervalSec` seconds.
 *
 * - Chronological order within a bucket is (start_at ASC, loan_id ASC) — the
 *   loan_id tiebreak makes same-second fills deterministic (loan ids are
 *   assigned in on-chain execution order). Rows are sorted here defensively
 *   even though the SQL already orders them, so the invariant doesn't depend
 *   on the caller.
 * - Only buckets with >= 1 fill are emitted — NO empty/interpolated buckets
 *   (§5.3 rule 1: gaps render as gaps). Output sorted ascending by `t`.
 * - Rows with a malformed `principal` are skipped entirely (fill + rate too)
 *   so a bucket's `fills` count always matches what `principalTotal` folded.
 */
export function foldRateCandles(
  rows: CandleFillRow[],
  intervalSec: number,
): RateCandleBucket[] {
  const sorted = [...rows].sort(
    (x, y) => x.start_at - y.start_at || x.loan_id - y.loan_id,
  );
  interface Acc {
    open: number;
    high: number;
    low: number;
    close: number;
    fills: number;
    principalTotal: bigint;
  }
  const buckets = new Map<number, Acc>();
  for (const row of sorted) {
    let principal: bigint;
    try {
      principal = BigInt(row.principal || '0');
    } catch {
      continue; // malformed row — skip whole fill, keep count/total consistent
    }
    const rate = row.interest_rate_bps;
    const t = Math.floor(row.start_at / intervalSec) * intervalSec;
    const acc = buckets.get(t);
    if (!acc) {
      buckets.set(t, {
        open: rate,
        high: rate,
        low: rate,
        close: rate,
        fills: 1,
        principalTotal: principal,
      });
    } else {
      acc.high = Math.max(acc.high, rate);
      acc.low = Math.min(acc.low, rate);
      acc.close = rate; // rows are chronological — last write wins
      acc.fills += 1;
      acc.principalTotal += principal;
    }
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([t, acc]) => ({
      t,
      open: acc.open,
      high: acc.high,
      low: acc.low,
      close: acc.close,
      fills: acc.fills,
      principalTotal: acc.principalTotal.toString(),
    }));
}
