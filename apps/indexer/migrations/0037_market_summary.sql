-- 0037_market_summary.sql — ingest-maintained market discovery summary
-- (#1270, split from PR #1269's PAG-010 review).
--
-- /offers/markets previously aggregated EVERY active offer + signed
-- offer per request: the response was capped (200 deepest + truncated)
-- but the GROUP BY work still scaled with the full spam set — a maker
-- fabricating thousands of dust pair/tenor markets kept the route's
-- per-request D1 cost unbounded. This table turns the route into a
-- pure indexed read (ORDER BY total DESC LIMIT N, zero per-request
-- aggregation); the aggregate runs only where writes happen:
--
--   * the ingest scan tail refreshes markets its scan touched
--     (offers/signed_offers stamped `updated_at` in the window) plus
--     markets whose rows time-expired in the window,
--   * the signed-offer POST path refreshes the posted market
--     synchronously,
--   * each refresh recomputes ONE market exactly (the same scoped
--     union aggregate the route used to run globally) — upserting the
--     row, or deleting it when the market empties.
--
-- Freshness: writes are same-scan / same-request; pure time-expiry
-- (a GTT signed order or expiring chain offer lapsing with no other
-- event) lags at most one ingest-scan cadence.
CREATE TABLE IF NOT EXISTS market_summary (
  chain_id         INTEGER NOT NULL,
  lending_asset    TEXT    NOT NULL,
  collateral_asset TEXT    NOT NULL,
  duration_days    INTEGER NOT NULL,
  lender_offers    INTEGER NOT NULL,
  borrower_offers  INTEGER NOT NULL,
  best_ask_bps     INTEGER,          -- NULL when no lender side
  best_bid_bps     INTEGER,          -- NULL when no borrower side
  total            INTEGER NOT NULL, -- lender_offers + borrower_offers (ranking key)
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (chain_id, lending_asset, collateral_asset, duration_days)
);

-- The route's whole read: top-N by depth within a chain.
CREATE INDEX IF NOT EXISTS idx_market_summary_depth
  ON market_summary (chain_id, total DESC);

-- The scan-tail touched-set queries filter on (chain_id, updated_at).
CREATE INDEX IF NOT EXISTS idx_offers_chain_updated
  ON offers (chain_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_signed_offers_chain_updated
  ON signed_offers (chain_id, updated_at);

-- One-time backfill so a deploy over live data serves discovery
-- immediately — the SAME union aggregate the route ran per-request
-- (offers leg: active, ERC-20 both legs, healed, non-vehicle, unexpired;
-- signed leg: active + GET /signed-offers' freshness predicate),
-- run ONCE at migration apply.
INSERT INTO market_summary (chain_id, lending_asset, collateral_asset,
                            duration_days, lender_offers, borrower_offers,
                            best_ask_bps, best_bid_bps, total, updated_at)
SELECT chain_id, lending_asset, collateral_asset, duration_days,
       SUM(lender_offers), SUM(borrower_offers),
       MIN(best_ask_bps), MAX(best_bid_bps),
       SUM(lender_offers) + SUM(borrower_offers),
       unixepoch()
  FROM (
    SELECT chain_id, lending_asset, collateral_asset, duration_days,
           SUM(CASE WHEN offer_type = 0 THEN 1 ELSE 0 END) AS lender_offers,
           SUM(CASE WHEN offer_type = 1 THEN 1 ELSE 0 END) AS borrower_offers,
           MIN(CASE WHEN offer_type = 0 THEN interest_rate_bps END) AS best_ask_bps,
           MAX(CASE WHEN offer_type = 1 THEN interest_rate_bps_max END) AS best_bid_bps
      FROM offers
     WHERE status = 'active'
       AND asset_type = 0 AND collateral_asset_type = 0
       AND is_stub = 0 AND is_sale_vehicle = 0 AND is_offset_vehicle = 0
       AND (expires_at = 0 OR expires_at > unixepoch())
     GROUP BY chain_id, lending_asset, collateral_asset, duration_days
    UNION ALL
    SELECT chain_id, lending_asset, collateral_asset, duration_days,
           SUM(CASE WHEN offer_type = 0 THEN 1 ELSE 0 END),
           SUM(CASE WHEN offer_type = 1 THEN 1 ELSE 0 END),
           MIN(CASE WHEN offer_type = 0 THEN interest_rate_bps END),
           MAX(CASE WHEN offer_type = 1 THEN interest_rate_bps_max END)
      FROM signed_offers
     WHERE status = 'active'
       AND asset_type = 0 AND collateral_asset_type = 0
       AND (expires_at = 0 OR expires_at > unixepoch())
       AND (deadline = 0 OR deadline > unixepoch())
     GROUP BY chain_id, lending_asset, collateral_asset, duration_days
  )
 GROUP BY chain_id, lending_asset, collateral_asset, duration_days;
