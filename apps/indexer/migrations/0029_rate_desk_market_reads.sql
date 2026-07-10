-- 0029_rate_desk_market_reads.sql — Rate Desk phase 1 (#1129) read surface.
--
-- The desk (ProRateTerminalDesign.md §7/§8) keys every market on the triple
-- (lending_asset, collateral_asset, duration_days) and needs three things
-- from the indexer that the current schema can't serve without global scans:
--
-- 1. `is_sale_vehicle` markers. Lender-sale vehicles mint a temporary
--    bookkeeping loan that is "not a real borrower position"
--    (LoanFacet.sol:199-204) yet emits LoanInitiated — a secondary sale must
--    never print on the desk's tape/candles as a fresh market fill. The
--    offer-side flag is set by the new `LoanSaleOfferLinked` handler
--    (the event fires in createLoanSaleOffer's tx, and processOfferLogs runs
--    before processLoanLogs, so the sale offer's row exists by then); the
--    loan-side flag is propagated from the initiating offer at LoanInitiated.
--
-- 2. Market-shaped indexes so the new pair+tenor filters on /loans/recent +
--    /offers/active and the /offers/markets summary don't devolve into
--    full-table scans (Codex #1128 round-2/round-4). Tails match each
--    route's ORDER BY (loan_id / offer_id DESC pagination).
--
-- 3. Nothing else — the phase-2 candle endpoint gets its own
--    (chain, pair, tenor, start_at) index in its own migration.

-- 1. Sale-vehicle markers (0 = real market fill / real offer).
ALTER TABLE offers ADD COLUMN is_sale_vehicle INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loans  ADD COLUMN is_sale_vehicle INTEGER NOT NULL DEFAULT 0;

-- 2. Market read indexes.
CREATE INDEX IF NOT EXISTS idx_offers_market
  ON offers (chain_id, status, lending_asset, collateral_asset, duration_days, offer_id);

CREATE INDEX IF NOT EXISTS idx_loans_market
  ON loans (chain_id, lending_asset, collateral_asset, duration_days, loan_id);
