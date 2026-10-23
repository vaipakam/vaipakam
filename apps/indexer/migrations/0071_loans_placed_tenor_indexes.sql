-- #1142 — a loan is a fill of a tenor market only when its AGREED terms are
-- confirmed (`init_terms_unbacked = 0`, 0058) and then of the agreed tenor,
-- `init_duration_days`, which `LoanExtended` never rewrites. A loan whose
-- terms are not confirmed (`init_terms_unbacked = 1`) is in no market and is
-- counted pair-wide instead. The rule lives in src/marketPlacement.ts and the
-- market-scoped reads use it:
--   - the tape (`/loans/recent` with a tenor) pages newest-first by
--     `loan_id`;
--   - the candles (`/loans/rate-candles`) range-scan by `start_at`;
--   - the candles' unplaced count range-scans the pair by `start_at`, bounded
--     by a row cap.
-- 0029's `idx_loans_market` keys the live `duration_days`, and 0032's
-- `idx_loans_market_start_at` keys `COALESCE(init_duration_days,
-- duration_days)`, the old fallback rule. Neither matches the new predicate,
-- and 0058's `idx_loans_init_terms_unbacked` keys only the chain.
--
-- Each index is partial on exactly one side of the placement flag, so it
-- holds only that side's loans and the planner uses it for any query carrying
-- the same literal term. The unplaced one also carries the candles' fill
-- scope (no sale vehicles, ERC-20 legs only), so its capped count stops after
-- the cap's worth of matching rows rather than reading past rows it would
-- discard.
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

CREATE INDEX IF NOT EXISTS idx_loans_unplaced_start_at
  ON loans (chain_id, lending_asset, collateral_asset, start_at)
  WHERE init_terms_unbacked = 1
    AND is_sale_vehicle = 0 AND asset_type = 0 AND collateral_asset_type = 0;
