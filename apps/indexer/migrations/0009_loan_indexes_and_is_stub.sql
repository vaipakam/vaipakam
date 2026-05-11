-- 0009_loan_indexes_and_is_stub.sql — symmetry with offers + add the
-- missing token-id indexes that the post-purge refresh pass leans on.
--
-- Background:
--
-- 1. Offers got an `is_stub` column in 0008 to replace the
--    `lending_asset = '0x' OR status = 'active'` predicate that
--    pegged the free-tier 50-subrequest cap during backfill. Loans
--    have an equivalent staleness signal — `lender_token_id = '0'`
--    — but it's an implicit string-sentinel rather than an explicit
--    boolean. This migration brings loans to parity: explicit
--    `is_stub`, identical lifecycle to offers (set to 0 on
--    inline-fetch success, 1 on stub-fallback INSERT, flipped to 0
--    when `refreshStubLoans` writes canonical token IDs).
--
-- 2. The token-id columns are queried in three hot paths:
--      - `refreshStubLoans`: `WHERE chain_id = ? AND lender_token_id = '0'`
--      - `/loans/by-lender/:addr`:    `WHERE chain_id = ? AND lender_token_id != '0' AND loan_id < ?`
--      - `/loans/by-borrower/:addr`:  `WHERE chain_id = ? AND borrower_token_id != '0' AND loan_id < ?`
--    Today none of these have a covering index — they fall through
--    to the `idx_loans_chain_lender` index (on the `lender` *address*
--    column, not the token-id), then post-filter in memory. That
--    works at testnet scale but degrades linearly with loan count.
--    Adding `(chain_id, lender_token_id)` + `(chain_id, borrower_token_id)`
--    indexes makes all three queries index-only.

-- 1. Add `is_stub` to loans, mirroring offers.is_stub.
ALTER TABLE loans ADD COLUMN is_stub INTEGER NOT NULL DEFAULT 0;

-- Backfill: any existing loan with lender_token_id = '0' is a stub.
-- Once `refreshStubLoans` heals such a row by writing real
-- token IDs, the chainIndexer flips is_stub to 0 alongside.
UPDATE loans SET is_stub = 1 WHERE lender_token_id = '0';

CREATE INDEX IF NOT EXISTS idx_loans_chain_is_stub
  ON loans (chain_id, is_stub);

-- 2. Token-id indexes for participant lookups + bootstrap pass.
CREATE INDEX IF NOT EXISTS idx_loans_chain_lender_token_id
  ON loans (chain_id, lender_token_id);

CREATE INDEX IF NOT EXISTS idx_loans_chain_borrower_token_id
  ON loans (chain_id, borrower_token_id);

-- 3. Time-series index for the analytics endpoint.
--
-- `handleLoansTimeseries` (loanRoutes.ts:751) buckets ERC-20 loans by
-- `start_at` to produce the TVL / interest-by-asset chart. Predicate:
--   `WHERE chain_id = ? AND asset_type = 0 AND start_at >= ?`
-- Today this falls through to a chain_id scan + in-memory time
-- filter. As loan count grows past a few thousand per chain the
-- filter cost becomes the dominant page-load latency on the
-- Analytics page. A composite (chain_id, start_at) index lets SQLite
-- range-scan exactly the relevant time window.
--
-- We don't include `asset_type` in the index because
-- ERC-20 (asset_type = 0) is overwhelmingly the dominant case at
-- testnet scale; the in-memory `asset_type = 0` filter on the
-- already-narrowed range is cheap. Adding asset_type as a third
-- index column would help only if NFT loans dominate, which they
-- don't.
CREATE INDEX IF NOT EXISTS idx_loans_chain_start_at
  ON loans (chain_id, start_at);
