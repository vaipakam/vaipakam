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
 *     ingest scan tail: finds every market a scan touched (offers /
 *     signed_offers rows stamped `updated_at >= sinceSec`, plus rows
 *     whose `expires_at`/`deadline` LAPSED inside (sinceSec, nowSec] —
 *     time-expiry mutates a market's active set with no write at all),
 *     and recomputes each exactly.
 *   - `refreshOneMarketSummary(db, chainId, market, nowSec)` — the
 *     signed-offer POST path (gasless posts never cross the chain
 *     scan, so the POST must maintain its own market synchronously).
 *
 * Every recompute is ONE market scoped through the same union
 * aggregate the route ran globally pre-#1270 (offers leg: active,
 * ERC-20 both legs, healed, non-vehicle, unexpired; signed leg: GET
 * /signed-offers' freshness predicate) — upsert when the market has
 * depth, DELETE when it emptied. Exactness therefore never depends on
 * incremental counter arithmetic; a missed refresh is self-healing on
 * the market's next touch.
 *
 * Failure posture: callers treat refreshes as fail-open derived-data
 * maintenance (a summary hiccup must never fail a scan whose cursor
 * already advanced, nor a signed POST that already persisted) — the
 * next scan's window re-covers the gap via the caller's sweep cursor.
 */

export interface MarketTriple {
  lendingAsset: string;
  collateralAsset: string;
  durationDays: number;
}

/** Ceiling on markets recomputed per sweep — a chain scan's touched
 *  set is gas-bounded and signed POSTs self-refresh, so this is a
 *  runaway backstop, not an expected limit. Overflow is logged by the
 *  caller and self-heals: un-refreshed markets stay stale only until
 *  their next touch or expiry-window pass. */
export const MARKET_SWEEP_CAP = 500;

/** One market's exact discovery aggregate — the pre-#1270 global
 *  query scoped to a single (pair, tenor). */
const ONE_MARKET_AGG = `
  SELECT SUM(lender_offers) AS lender_offers,
         SUM(borrower_offers) AS borrower_offers,
         MIN(best_ask_bps) AS best_ask_bps,
         MAX(best_bid_bps) AS best_bid_bps
    FROM (
      SELECT SUM(CASE WHEN offer_type = 0 THEN 1 ELSE 0 END) AS lender_offers,
             SUM(CASE WHEN offer_type = 1 THEN 1 ELSE 0 END) AS borrower_offers,
             MIN(CASE WHEN offer_type = 0 THEN interest_rate_bps END) AS best_ask_bps,
             MAX(CASE WHEN offer_type = 1 THEN interest_rate_bps_max END) AS best_bid_bps
        FROM offers
       WHERE chain_id = ?1 AND lending_asset = ?2 AND collateral_asset = ?3
         AND duration_days = ?4
         AND status = 'active'
         AND asset_type = 0 AND collateral_asset_type = 0
         AND is_stub = 0 AND is_sale_vehicle = 0 AND is_offset_vehicle = 0
         AND (expires_at = 0 OR expires_at > ?5)
      UNION ALL
      SELECT SUM(CASE WHEN offer_type = 0 THEN 1 ELSE 0 END),
             SUM(CASE WHEN offer_type = 1 THEN 1 ELSE 0 END),
             MIN(CASE WHEN offer_type = 0 THEN interest_rate_bps END),
             MAX(CASE WHEN offer_type = 1 THEN interest_rate_bps_max END)
        FROM signed_offers
       WHERE chain_id = ?1 AND lending_asset = ?2 AND collateral_asset = ?3
         AND duration_days = ?4
         AND status = 'active'
         AND asset_type = 0 AND collateral_asset_type = 0
         AND (expires_at = 0 OR expires_at > ?5)
         AND (deadline = 0 OR deadline > ?5)
    )`;

/** Recompute ONE market's summary row exactly: upsert when it has
 *  depth, delete when it emptied. */
export async function refreshOneMarketSummary(
  db: D1Database,
  chainId: number,
  market: MarketTriple,
  nowSec: number,
): Promise<void> {
  const lendingAsset = market.lendingAsset.toLowerCase();
  const collateralAsset = market.collateralAsset.toLowerCase();
  const row = await db
    .prepare(ONE_MARKET_AGG)
    .bind(chainId, lendingAsset, collateralAsset, market.durationDays, nowSec)
    .first<{
      lender_offers: number | null;
      borrower_offers: number | null;
      best_ask_bps: number | null;
      best_bid_bps: number | null;
    }>();
  const lender = row?.lender_offers ?? 0;
  const borrower = row?.borrower_offers ?? 0;
  if (lender + borrower <= 0) {
    await db
      .prepare(
        `DELETE FROM market_summary
         WHERE chain_id = ? AND lending_asset = ? AND collateral_asset = ?
           AND duration_days = ?`,
      )
      .bind(chainId, lendingAsset, collateralAsset, market.durationDays)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO market_summary (chain_id, lending_asset, collateral_asset,
         duration_days, lender_offers, borrower_offers, best_ask_bps,
         best_bid_bps, total, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (chain_id, lending_asset, collateral_asset, duration_days)
       DO UPDATE SET lender_offers = excluded.lender_offers,
                     borrower_offers = excluded.borrower_offers,
                     best_ask_bps = excluded.best_ask_bps,
                     best_bid_bps = excluded.best_bid_bps,
                     total = excluded.total,
                     updated_at = excluded.updated_at`,
    )
    .bind(
      chainId,
      lendingAsset,
      collateralAsset,
      market.durationDays,
      lender,
      borrower,
      row?.best_ask_bps ?? null,
      row?.best_bid_bps ?? null,
      lender + borrower,
      nowSec,
    )
    .run();
}

/** Every market a window's writes OR time-expiries touched. The three
 *  UNIONed touched-set legs are each index-served and bounded by the
 *  window: `updated_at` legs ride idx_*_chain_updated (handlers stamp
 *  wall-clock scan time, so catch-up scans over old blocks are still
 *  caught); the expiry legs catch rows whose expires_at/deadline
 *  LAPSED in the window — the "no event, market changed anyway" case.
 *  The offers expiry leg deliberately keeps quotable-shape predicates
 *  (an expiring stub/vehicle never contributed to a summary row);
 *  the signed legs match the book's own scoping. */
async function touchedMarkets(
  db: D1Database,
  chainId: number,
  sinceSec: number,
  nowSec: number,
): Promise<MarketTriple[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT lending_asset, collateral_asset, duration_days FROM (
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
            AND ((expires_at > ?2 AND expires_at <= ?3)
              OR (deadline > ?2 AND deadline <= ?3))
       )
       LIMIT ?4`,
    )
    .bind(chainId, sinceSec, nowSec, MARKET_SWEEP_CAP + 1)
    .all<{ lending_asset: string; collateral_asset: string; duration_days: number }>();
  return (rows.results ?? []).map((r) => ({
    lendingAsset: r.lending_asset,
    collateralAsset: r.collateral_asset,
    durationDays: r.duration_days,
  }));
}

/** Sweep every market touched in (sinceSec, nowSec] and recompute
 *  each exactly. Returns the number refreshed plus whether the sweep
 *  hit its backstop cap (caller logs; the overflow self-heals on the
 *  markets' next touch). */
export async function refreshMarketSummaries(
  db: D1Database,
  chainId: number,
  sinceSec: number,
  nowSec: number,
): Promise<{ refreshed: number; capped: boolean }> {
  const touched = await touchedMarkets(db, chainId, sinceSec, nowSec);
  const capped = touched.length > MARKET_SWEEP_CAP;
  const work = capped ? touched.slice(0, MARKET_SWEEP_CAP) : touched;
  for (const market of work) {
    await refreshOneMarketSummary(db, chainId, market, nowSec);
  }
  return { refreshed: work.length, capped };
}
