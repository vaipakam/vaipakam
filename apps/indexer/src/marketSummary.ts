/**
 * market_summary maintenance (#1270) — the write-side half of the
 * bounded /offers/markets read.
 *
 * The summary table (migration 0037) holds one row per quotable
 * (chain, pair, tenor) market with the SAME numbers the route used to
 * aggregate globally per request. This module recomputes rows only
 * where writes happen:
 *
 *   - `refreshMarketSummaries(db, chainId, sinceSec, nowSec)` — the
 *     ingest scan tail: refreshes every market a window touched
 *     (offers / signed_offers rows stamped `updated_at >= sinceSec`,
 *     plus rows whose `expires_at`/`deadline` LAPSED inside
 *     (sinceSec, nowSec] — time-expiry mutates a market's active set
 *     with no write at all).
 *   - `refreshOneMarketSummary(db, chainId, market, nowSec)` — the
 *     signed-offer POST path (gasless posts never cross the chain
 *     scan, so the POST must maintain its own market synchronously).
 *
 * Both are SET-BASED and ATOMIC (Codex #1288 r1): each refresh is one
 * `db.batch([DELETE touched, INSERT..SELECT recompute])` — D1 runs a
 * batch as a single transaction, and the INSERT's SELECT reads the
 * source tables at execution time, so
 *   - there is no per-market loop, no sweep cap, and no skipped-market
 *     watermark hazard — the caller may safely advance its window
 *     cursor after ANY successful sweep (P1);
 *   - a concurrent POST refresh and scan sweep can interleave in any
 *     order and the LAST writer always writes CURRENT source data —
 *     no stale read-then-write snapshot can clobber a fresher row (P2);
 *   - a whole sweep costs a constant number of D1 subrequests
 *     (2 statements + the caller's cursor read/write), independent of
 *     how many markets the window touched (P3).
 *
 * The recompute is the same union aggregate the route ran globally
 * pre-#1270 (offers leg: active, ERC-20 both legs, healed,
 * non-vehicle, unexpired; signed leg: GET /signed-offers' freshness
 * predicate), scoped to the touched set. Markets that recompute to
 * zero simply stay deleted. Exactness never depends on incremental
 * counter arithmetic; a missed refresh is self-healing on the
 * market's next touch.
 *
 * Failure posture: callers treat refreshes as fail-open derived-data
 * maintenance (a summary hiccup must never fail a scan whose cursor
 * already advanced, nor a signed POST that already persisted) — the
 * caller's window cursor is only advanced after a successful sweep,
 * so a failed window is re-covered next scan.
 */

export interface MarketTriple {
  lendingAsset: string;
  collateralAsset: string;
  durationDays: number;
}

/** Every market a window's writes OR time-expiries touched — the
 *  shared subquery both batch statements scope on. Binds: ?1 chainId,
 *  ?2 sinceSec, ?3 nowSec. The `updated_at` legs ride
 *  idx_*_chain_updated (handlers stamp wall-clock scan time, so
 *  catch-up scans over old blocks are still caught); the expiry legs
 *  catch rows whose expires_at/deadline LAPSED in the window. The
 *  offers expiry leg keeps quotable-shape predicates (an expiring
 *  stub/vehicle never contributed a summary row). */
const TOUCHED_MARKETS = `
  SELECT DISTINCT lending_asset, collateral_asset, duration_days FROM (
    SELECT lending_asset, collateral_asset, duration_days
      FROM offers WHERE chain_id = ?1 AND updated_at >= ?2
    UNION ALL
    SELECT lending_asset, collateral_asset, duration_days
      FROM signed_offers WHERE chain_id = ?1 AND updated_at >= ?2
    UNION ALL
    SELECT lending_asset, collateral_asset, duration_days
      FROM offers
     WHERE chain_id = ?1 AND status = 'active'
       AND asset_type = 0 AND collateral_asset_type = 0
       AND is_stub = 0 AND is_sale_vehicle = 0 AND is_offset_vehicle = 0
       AND expires_at > ?2 AND expires_at <= ?3
    UNION ALL
    SELECT lending_asset, collateral_asset, duration_days
      FROM signed_offers
     WHERE chain_id = ?1 AND status = 'active'
       AND expires_at > ?2 AND expires_at <= ?3
    UNION ALL
    SELECT lending_asset, collateral_asset, duration_days
      FROM signed_offers
     WHERE chain_id = ?1 AND status = 'active'
       AND deadline > ?2 AND deadline <= ?3
  )`;

/** The exact discovery aggregate over a scoped market set. `SCOPE` is
 *  interpolated as a row-value IN predicate body (a trusted SQL
 *  literal from this module, never caller input). Binds: ?1 chainId,
 *  ?3 nowSec (?2 stays sinceSec for the sweep's scope; the one-market
 *  variant re-purposes ?2/?4 for the triple). */
function recomputeSql(scope: string): string {
  return `
  INSERT INTO market_summary (chain_id, lending_asset, collateral_asset,
    duration_days, lender_offers, borrower_offers, best_ask_bps,
    best_bid_bps, total, updated_at)
  SELECT ?1, lending_asset, collateral_asset, duration_days,
         SUM(lender_offers), SUM(borrower_offers),
         MIN(best_ask_bps), MAX(best_bid_bps),
         SUM(lender_offers) + SUM(borrower_offers), ?3
    FROM (
      SELECT lending_asset, collateral_asset, duration_days,
             SUM(CASE WHEN offer_type = 0 THEN 1 ELSE 0 END) AS lender_offers,
             SUM(CASE WHEN offer_type = 1 THEN 1 ELSE 0 END) AS borrower_offers,
             MIN(CASE WHEN offer_type = 0 THEN interest_rate_bps END) AS best_ask_bps,
             MAX(CASE WHEN offer_type = 1 THEN interest_rate_bps_max END) AS best_bid_bps
        FROM offers
       WHERE chain_id = ?1 AND status = 'active'
         AND asset_type = 0 AND collateral_asset_type = 0
         AND is_stub = 0 AND is_sale_vehicle = 0 AND is_offset_vehicle = 0
         AND (expires_at = 0 OR expires_at > ?3)
         AND (lending_asset, collateral_asset, duration_days) IN (${scope})
       GROUP BY lending_asset, collateral_asset, duration_days
      UNION ALL
      SELECT lending_asset, collateral_asset, duration_days,
             SUM(CASE WHEN offer_type = 0 THEN 1 ELSE 0 END),
             SUM(CASE WHEN offer_type = 1 THEN 1 ELSE 0 END),
             MIN(CASE WHEN offer_type = 0 THEN interest_rate_bps END),
             MAX(CASE WHEN offer_type = 1 THEN interest_rate_bps_max END)
        FROM signed_offers
       WHERE chain_id = ?1 AND status = 'active'
         AND asset_type = 0 AND collateral_asset_type = 0
         AND (expires_at = 0 OR expires_at > ?3)
         AND (deadline = 0 OR deadline > ?3)
         AND (lending_asset, collateral_asset, duration_days) IN (${scope})
       GROUP BY lending_asset, collateral_asset, duration_days
    )
   GROUP BY lending_asset, collateral_asset, duration_days
  HAVING SUM(lender_offers) + SUM(borrower_offers) > 0`;
}

function deleteSql(scope: string): string {
  return `
  DELETE FROM market_summary
   WHERE chain_id = ?1
     AND (lending_asset, collateral_asset, duration_days) IN (${scope})`;
}

/** Sweep every market touched in (sinceSec, nowSec] and recompute the
 *  whole set atomically. Constant D1 cost regardless of touched-set
 *  size; safe to advance the caller's window cursor on success. */
export async function refreshMarketSummaries(
  db: D1Database,
  chainId: number,
  sinceSec: number,
  nowSec: number,
): Promise<void> {
  await db.batch([
    db.prepare(deleteSql(TOUCHED_MARKETS)).bind(chainId, sinceSec, nowSec),
    db.prepare(recomputeSql(TOUCHED_MARKETS)).bind(chainId, sinceSec, nowSec),
  ]);
}

/** Single-market scope for the signed-POST path. Binds: ?2 lending,
 *  ?4 collateral, ?5 durationDays (?1/?3 stay chainId/now to match
 *  the shared recompute SQL's placeholders). */
const ONE_MARKET = `SELECT ?2, ?4, ?5`;

/** Recompute ONE market's summary row exactly (atomic, set-based —
 *  same properties as the sweep). */
export async function refreshOneMarketSummary(
  db: D1Database,
  chainId: number,
  market: MarketTriple,
  nowSec: number,
): Promise<void> {
  const binds = [
    chainId,
    market.lendingAsset.toLowerCase(),
    nowSec,
    market.collateralAsset.toLowerCase(),
    market.durationDays,
  ] as const;
  await db.batch([
    db.prepare(deleteSql(ONE_MARKET)).bind(...binds),
    db.prepare(recomputeSql(ONE_MARKET)).bind(...binds),
  ]);
}
