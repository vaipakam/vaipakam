-- 0036_signed_offers_signer_market_idx.sql — signer-first per-side
-- indexes for the signer-scoped signed-book read (#1247 PAG-011,
-- Codex #1269 rounds 1–2).
--
-- GET /signed-offers?...&signer=0x… must serve a maker's OWN orders
-- without walking other makers' depth. EXPLAIN QUERY PLAN against the
-- migrated schema showed the planner picking the per-side book indexes
-- (idx_signed_offers_book_ask/bid) for the scoped query — they match
-- the market equality prefix AND the price ORDER BY, leaving `signer`
-- as a residual filter over other makers' price-ordered rows: in a
-- spammed market that is exactly the unbounded walk the signer scope
-- exists to bypass. A single market+signer index without the price
-- columns was not enough — the ORDER BY kept pulling the planner back
-- to the book indexes. So: one signer-first index PER SIDE, mirroring
-- the 0033 book indexes with `signer` inserted after chain_id. Each
-- gives the scoped query seven equality-matched leading columns
-- (verified: the planner selects these for signer-scoped reads and
-- keeps the book indexes for unscoped ones), so the scan touches only
-- the maker's own rows in the market. The generic (chain_id, signer)
-- index from 0033 stays for the market-unscoped nonce-burn fan-out.
CREATE INDEX IF NOT EXISTS idx_signed_offers_signer_book_ask
  ON signed_offers (chain_id, signer, status, lending_asset,
                    collateral_asset, duration_days, offer_type,
                    interest_rate_bps, created_at);
CREATE INDEX IF NOT EXISTS idx_signed_offers_signer_book_bid
  ON signed_offers (chain_id, signer, status, lending_asset,
                    collateral_asset, duration_days, offer_type,
                    interest_rate_bps_max DESC, created_at);
