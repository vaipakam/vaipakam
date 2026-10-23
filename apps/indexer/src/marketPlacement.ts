/**
 * #1142 — which tenor MARKET a loan is a fill of. ONE rule, used by every
 * surface that places a loan in a market: the market-scoped tape
 * (`/loans/recent` with a tenor), the executed-rate candles
 * (`/loans/rate-candles`) and the `marketDurationDays` key each loan row
 * carries.
 *
 * A loan is placed in a tenor market only when its AGREED terms are
 * confirmed: the initiation snapshot (0032) is backed by the chain's own
 * `LoanInitiatedDetails` (`init_terms_unbacked = 0`, migration 0058) and
 * carries both the rate and the duration. The market is then the agreed
 * duration, which `LoanExtended` never rewrites, so an extended 30-day loan
 * stays a 30-day fill.
 *
 * A loan whose terms are NOT confirmed is placed in no market. Its snapshot
 * may have been copied from the live columns after an extension (0032's
 * backfill, the unpinned `getLoanDetails` heal), so the tenor it names is a
 * guess, and so is the rate. Filing it under that tenor, or under the live
 * one, would present a guess as an executed fill (Codex #2689 r3). It is
 * counted instead (`countUnplacedOnPair`, the candles' `unplaced`) and the desk says
 * how many such loans the pair has. Each tick's `reverifyInitTerms` clears
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

/**
 * The WHERE fragment for "placed in the tenor market `?`" (one bind: the
 * duration in days). The `init_terms_unbacked = 0` term is spelled exactly as
 * the partial indexes' condition (0071), so the planner can use them.
 */
export const PLACED_IN_TENOR_SQL =
  '(init_terms_unbacked = 0 AND init_rate_bps IS NOT NULL AND init_duration_days = ?)';

/**
 * Loans on one ERC-20 pair, started at or after `sinceSec`, that NO tenor
 * market holds: the complement of `PLACED_IN_TENOR_SQL`, over the candles'
 * fill scope minus the tenor (sale vehicles and NFT legs are not fills).
 * Pair-wide on purpose: an unconfirmed loan's tenor is unknown, so it can be
 * neither attributed to a tenor nor excluded from one. Written as one static
 * statement so the SQL-vs-schema guard prepares it.
 */
export async function countUnplacedOnPair(
  db: D1Database,
  chainId: number,
  lendingAsset: string,
  collateralAsset: string,
  sinceSec: number,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM loans
       WHERE chain_id = ? AND lending_asset = ? AND collateral_asset = ?
         AND (init_terms_unbacked != 0 OR init_rate_bps IS NULL OR init_duration_days IS NULL)
         AND is_sale_vehicle = 0 AND asset_type = 0 AND collateral_asset_type = 0
         AND start_at >= ?`,
    )
    .bind(chainId, lendingAsset, collateralAsset, sinceSec)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** The tenor market a loan row is placed in, or null when it is in none.
 *  Backed is the explicit 0 only: an absent flag (a Worker reading a row
 *  before its migration) is "not known to be backed". */
export function placedTenorOf(row: PlacementRow): number | null {
  if (row.init_terms_unbacked !== 0) return null;
  if (typeof row.init_rate_bps !== 'number') return null;
  return typeof row.init_duration_days === 'number' ? row.init_duration_days : null;
}
