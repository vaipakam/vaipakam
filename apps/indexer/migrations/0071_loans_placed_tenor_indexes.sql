-- #1142 — a loan is a fill of a tenor market only when its AGREED terms are
-- confirmed (`init_terms_unbacked = 0`, 0058) and then of the agreed tenor,
-- `init_duration_days`, which `LoanExtended` never rewrites. The rule lives in
-- src/marketPlacement.ts and both market-scoped reads use it:
--   - the tape (`/loans/recent` with a tenor) pages newest-first by
--     `loan_id`;
--   - the candles (`/loans/rate-candles`) range-scan by `start_at`.
-- 0029's `idx_loans_market` keys the live `duration_days`, and 0032's
-- `idx_loans_market_start_at` keys `COALESCE(init_duration_days,
-- duration_days)`, the old fallback rule. Neither matches the new predicate.
--
-- Partial on exactly the placement flag, so the indexes hold only placed
-- loans and the planner uses them for any query carrying the literal
-- `init_terms_unbacked = 0` term.
--
-- Additive: indexes only. The deployed code's queries are unchanged by them,
-- and the new queries still answer (more slowly) on a database this has not
-- reached.
CREATE INDEX IF NOT EXISTS idx_loans_placed_tenor_loan
  ON loans (chain_id, lending_asset, collateral_asset, init_duration_days, loan_id)
  WHERE init_terms_unbacked = 0;

CREATE INDEX IF NOT EXISTS idx_loans_placed_tenor_start_at
  ON loans (chain_id, lending_asset, collateral_asset, init_duration_days, start_at)
  WHERE init_terms_unbacked = 0;
