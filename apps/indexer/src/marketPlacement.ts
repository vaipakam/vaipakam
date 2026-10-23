/**
 * #1142 — which tenor MARKET a loan is a fill of. ONE rule, used by every
 * surface that places a loan in a market: the market-scoped tape
 * (`/loans/recent` with a tenor), the executed-rate candles
 * (`/loans/rate-candles`) and the `marketDurationDays` key each loan row
 * carries.
 *
 * A loan is placed in a tenor market only when its AGREED terms are
 * confirmed: the initiation snapshot (0032) is backed by the chain's own
 * `LoanInitiatedDetails` (`init_terms_unbacked = 0`, migration 0058), which
 * by the writer invariant below carries both the rate and the duration. The market is then the agreed
 * duration, which `LoanExtended` never rewrites, so an extended 30-day loan
 * stays a 30-day fill.
 *
 * A loan whose terms are NOT confirmed is placed in no market. Its snapshot
 * may have been copied from the live columns after an extension (0032's
 * backfill, the unpinned `getLoanDetails` heal), so the tenor it names is a
 * guess, and so is the rate. Filing it under that tenor, or under the live
 * one, would present a guess as an executed fill (Codex #2689 r3). It is
 * counted instead (`unplacedOnPairStatement`, the candles' `unplaced`) and the
 * desk says how many such loans the pair has. Each tick's `reverifyInitTerms` clears
 * the flag once the ledger carries the details, and the loan then joins its
 * market.
 *
 * The SQL, the count's complement of it and the JS twin below must agree;
 * `marketTapeTenor.test.ts` and `rateCandlesRoute.test.ts` pin them against
 * the same rows.
 */

/** The row fields the rule reads. */
export interface PlacementRow {
  init_terms_unbacked?: number | null;
  init_rate_bps?: number | null;
  init_duration_days?: number | null;
}

/*
 * WRITER INVARIANT the rule rests on: `init_terms_unbacked = 0` implies both
 * `init_rate_bps` and `init_duration_days` are set. Every writer of the 0
 * keeps it: the `LoanInitiatedDetails` insert stamps 0 together with the
 * terms it carries, `reverifyInitTerms` clears the flag only on a row whose
 * two values are NOT NULL and equal the ledger's, and 0058's backfill
 * requires both. So the placed set is keyed on the flag ALONE, and the
 * unplaced set is its exact complement, `init_terms_unbacked = 1` (the
 * column is NOT NULL, default 1, and only ever 0 or 1). Keying on the flag
 * alone is what lets each side use a partial index (0071) whose condition is
 * that same literal term.
 */

/**
 * The name of this rule as a response states it. A market-scoped response
 * echoes it (with the scope it applied) so a reader can tell a response
 * scoped by this rule from one that is not: an empty page carries no row on
 * which a missing per-row key could show (Codex #2689 r5).
 */
export const PLACEMENT_RULE = 'confirmed-agreed-terms';

/**
 * The WHERE fragment for "placed in the tenor market `?`" (one bind: the
 * duration in days). Spelled exactly as the placed partial indexes'
 * condition (0071), so the planner can use them.
 */
export const PLACED_IN_TENOR_SQL = '(init_terms_unbacked = 0 AND init_duration_days = ?)';

/**
 * How many unplaced loans one candle response counts before it stops and
 * says "more than". The count is a disclosure, not a statistic: past this
 * many the sentence the desk shows is the same, so a pair with a long
 * unconfirmed history must not cost a full range scan per request.
 */
export const UNPLACED_COUNT_CAP = 1_000;

/** The unplaced disclosure one candle response carries. `capped` = the pair
 *  has MORE than `count` such loans in range (`count` is then the cap). */
export interface UnplacedCount {
  count: number;
  capped: boolean;
}

/**
 * Loans on one ERC-20 pair, started at or after `sinceSec`, that NO tenor
 * market holds: the complement of `PLACED_IN_TENOR_SQL`, over the candles'
 * fill scope minus the tenor (sale vehicles and NFT legs are not fills).
 * Pair-wide on purpose: an unconfirmed loan's tenor is unknown, so it can be
 * neither attributed to a tenor nor excluded from one.
 *
 * Returned as a STATEMENT, not a result, so the caller runs it in the same
 * `batch` as the candle read: both then describe one snapshot of the table,
 * and a loan whose flag clears between two separate reads can be neither
 * missed by both nor counted by both. Bounded by `UNPLACED_COUNT_CAP + 1`
 * rows over the partial index `idx_loans_unplaced_start_at` (0071), whose
 * condition this WHERE repeats term for term. Static SQL, so the
 * SQL-vs-schema guard prepares it.
 */
export function unplacedOnPairStatement(
  db: D1Database,
  chainId: number,
  lendingAsset: string,
  collateralAsset: string,
  sinceSec: number,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM loans
         WHERE chain_id = ? AND lending_asset = ? AND collateral_asset = ?
           AND start_at >= ?
           AND init_terms_unbacked = 1
           AND is_sale_vehicle = 0 AND asset_type = 0 AND collateral_asset_type = 0
         LIMIT ?
       )`,
    )
    .bind(chainId, lendingAsset, collateralAsset, sinceSec, UNPLACED_COUNT_CAP + 1);
}

/** Read `unplacedOnPairStatement`'s result into the response's disclosure. */
export function readUnplacedCount(result: D1Result<{ n: number }>): UnplacedCount {
  const n = Number(result.results?.[0]?.n ?? 0);
  return n > UNPLACED_COUNT_CAP
    ? { count: UNPLACED_COUNT_CAP, capped: true }
    : { count: n, capped: false };
}

/** The tenor market a loan row is placed in, or null when it is in none —
 *  the JS twin of `PLACED_IN_TENOR_SQL`. Placed is the explicit 0 only, so
 *  an absent flag is "not known to be confirmed". A flag-0 row with no
 *  duration (one that broke the writer invariant) is in no tenor here, as it
 *  matches no tenor in the SQL. */
export function placedTenorOf(row: PlacementRow): number | null {
  if (row.init_terms_unbacked !== 0) return null;
  return typeof row.init_duration_days === 'number' ? row.init_duration_days : null;
}
