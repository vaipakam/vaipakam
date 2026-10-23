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

/**
 * Allowed `interval` values → bucket width in seconds.
 *
 * NULL-PROTOTYPE + frozen (both public candle enums): these are looked
 * up with RAW query-string keys, and a plain object literal would
 * resolve inherited keys — `?interval=toString` returns
 * `Object.prototype.toString` instead of `undefined`, bypassing the
 * 400 validation and feeding the fold a non-numeric interval (Codex
 * #1139 round-1 P3). The handler ALSO gates each lookup with
 * `Object.hasOwn` so neither layer's discipline can silently regress.
 */
export const CANDLE_INTERVALS: Readonly<Record<string, number>> =
  Object.freeze(
    Object.assign(Object.create(null) as Record<string, number>, {
      '1h': 3600,
      '4h': 14400,
      '1d': 86400,
    }),
  );

/** Allowed `range` values → lookback in days (null = no lower time
 *  bound). Null-prototype + frozen — see CANDLE_INTERVALS. */
export const CANDLE_RANGES: Readonly<Record<string, number | null>> =
  Object.freeze(
    Object.assign(Object.create(null) as Record<string, number | null>, {
      '7d': 7,
      '30d': 30,
      '90d': 90,
      all: null,
    }),
  );

/** The columns the candle SQL selects per fill: the INITIATION snapshot and
 *  the two flags that say whether the ledger backs it (0056, 0058). Never the
 *  live columns, which extensions and repayments rewrite (#1142). */
export interface CandleFillRow {
  loan_id: number;
  start_at: number; // unix seconds — the loan's start timestamp
  init_rate_bps: number | null;
  /** 0 = the rate and duration are backed by the initiation event. Anything
   *  else, including an absent column, is "not known to be backed". */
  init_terms_unbacked: number | null;
  init_principal: string | null; // decimal string, raw base units
  /** 0 = the principal is backed by the initiation event. */
  init_principal_unbacked: number | null;
}

export interface RateCandleBucket {
  t: number; // bucket start, unix seconds
  open: number; // first fill's rate (bps) in the bucket, chronological
  high: number;
  low: number;
  close: number; // last fill's rate (bps) in the bucket, chronological
  /** Fills drawn in this bucket: every one has a recorded rate. */
  fills: number;
  /** BigInt-folded decimal string (never a JSON number) over the drawn fills
   *  whose principal is recorded. */
  principalTotal: string;
  /** Drawn fills whose principal is NOT recorded, so `principalTotal` leaves
   *  them out. The total is a floor whenever this is above zero. */
  unrecordedPrincipalFills: number;
}

/** Fills in a bucket whose executed rate is not recorded. They happened, so
 *  they are counted; their rate is unknown, so nothing is drawn for them. */
export interface UnrecordedRateBucket {
  t: number;
  fills: number;
}

export interface FoldedRateCandles {
  buckets: RateCandleBucket[];
  unrecorded: UnrecordedRateBucket[];
}

/** The executed rate, or null when the snapshot is not backed. */
function recordedRate(row: CandleFillRow): number | null {
  if (row.init_terms_unbacked !== 0) return null;
  const rate = row.init_rate_bps;
  return typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
}

/** The initiated principal, or null when it is not backed or not a number. */
function recordedPrincipal(row: CandleFillRow): bigint | null {
  // An empty string is no figure at all, even under a backed flag.
  if (row.init_principal_unbacked !== 0 || !row.init_principal) return null;
  try {
    return BigInt(row.init_principal);
  } catch {
    return null;
  }
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
 * - PROVENANCE (#1142): a fill is drawn only when its executed rate is
 *   recorded. A fill whose rate is not recorded is counted in `unrecorded`
 *   instead, never drawn at the live rate or at an unverified snapshot, which
 *   would plot a figure nobody can stand behind as executed. A drawn fill
 *   whose principal is not recorded adds to `unrecordedPrincipalFills` and
 *   nothing to `principalTotal`.
 */
export function foldRateCandles(
  rows: CandleFillRow[],
  intervalSec: number,
): FoldedRateCandles {
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
    unrecordedPrincipalFills: number;
  }
  const buckets = new Map<number, Acc>();
  const unrecorded = new Map<number, number>();
  for (const row of sorted) {
    const t = Math.floor(row.start_at / intervalSec) * intervalSec;
    const rate = recordedRate(row);
    if (rate === null) {
      unrecorded.set(t, (unrecorded.get(t) ?? 0) + 1);
      continue;
    }
    const principal = recordedPrincipal(row);
    const acc = buckets.get(t);
    if (!acc) {
      buckets.set(t, {
        open: rate,
        high: rate,
        low: rate,
        close: rate,
        fills: 1,
        principalTotal: principal ?? 0n,
        unrecordedPrincipalFills: principal === null ? 1 : 0,
      });
    } else {
      acc.high = Math.max(acc.high, rate);
      acc.low = Math.min(acc.low, rate);
      acc.close = rate; // rows are chronological — last write wins
      acc.fills += 1;
      if (principal === null) acc.unrecordedPrincipalFills += 1;
      else acc.principalTotal += principal;
    }
  }
  return {
    buckets: Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([t, acc]) => ({
        t,
        open: acc.open,
        high: acc.high,
        low: acc.low,
        close: acc.close,
        fills: acc.fills,
        principalTotal: acc.principalTotal.toString(),
        unrecordedPrincipalFills: acc.unrecordedPrincipalFills,
      })),
    unrecorded: Array.from(unrecorded.entries())
      .sort(([a], [b]) => a - b)
      .map(([t, fills]) => ({ t, fills })),
  };
}
