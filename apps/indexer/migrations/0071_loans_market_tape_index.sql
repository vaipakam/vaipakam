-- #1142 — the market-scoped tape (`/loans/recent` with a tenor) now selects
-- on the tenor a loan EXECUTED in, `COALESCE(init_duration_days,
-- duration_days)`, the expression the candles already use (0032). It pages
-- newest-first by `loan_id`, which 0032's `idx_loans_market_start_at`
-- (ordered by `start_at`) does not serve, and 0029's `idx_loans_market` keys
-- the live `duration_days`. This index matches the tape's WHERE and ORDER BY.
--
-- Additive: an index only. The deployed code's queries are unchanged by it,
-- and the new query still answers (by a sort) on a database this has not
-- reached.
CREATE INDEX IF NOT EXISTS idx_loans_market_init_tenor_loan
  ON loans (chain_id, lending_asset, collateral_asset,
            COALESCE(init_duration_days, duration_days), loan_id);
