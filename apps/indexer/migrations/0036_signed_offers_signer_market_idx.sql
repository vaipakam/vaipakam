-- 0036_signed_offers_signer_market_idx.sql — signer-first index for the
-- signer-scoped signed-book read (#1247 PAG-011, Codex #1269 round 1).
--
-- GET /signed-offers?...&signer=0x… must serve a maker's OWN orders
-- without walking other makers' depth. Without this index the planner
-- can prefer idx_signed_offers_book_ask/bid (they match six equality
-- columns AND satisfy the price ORDER BY), which walks the market's
-- price-ordered rows filtering on signer — in a spammed market that is
-- exactly the unbounded walk the signer scope exists to bypass. This
-- index leads with the same market-scoping equality columns PLUS
-- signer, so the scoped read touches only the maker's own rows in the
-- market (a maker's own order count is small; the residual sort is
-- trivial). The generic (chain_id, signer) index from 0033 stays for
-- the nonce-burn fan-out, which has no market scope.
CREATE INDEX IF NOT EXISTS idx_signed_offers_signer_market
  ON signed_offers (chain_id, signer, status, lending_asset,
                    collateral_asset, duration_days, offer_type);
