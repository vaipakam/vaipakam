-- #2467 — whether a loan's initiation RATE and DURATION snapshot is backed by
-- the chain's own `LoanInitiatedDetails`, kept beside the values without
-- changing them. The rate/duration twin of 0056 (`init_principal_unbacked`).
--
-- `init_rate_bps` / `init_duration_days` are the terms a loan executed at
-- (0032). `LoanExtended` rewrites the live `interest_rate_bps` /
-- `duration_days`, so the snapshot is what a history view must show. But not
-- every stamp is substantiated:
--   - 0032 backfilled rows it could not trace to a ledger row from the
--     MUTABLE columns — after an extension, the extended terms;
--   - the missing-details insert path and the stub heal fill them from an
--     UNPINNED `getLoanDetails` read, which during catch-up can already
--     carry an extension.
-- The candles keep reading the values (a frozen best figure, exactly as for
-- the principal); the loan routes serve them only when this flag is clear.
--
-- DERIVED, not trusted from the writer, for the same reason 0056 is:
--   - DEFAULT 1 (withheld), so a row the previous Worker writes between this
--     migration's apply and the new Worker's publish starts withheld;
--   - the primary insert path stamps 0 — it takes both values from the
--     `LoanInitiatedDetails` event itself;
--   - every tick clears the flag wherever the ledger's `LoanInitiatedDetails`
--     for that loan carries BOTH values (`reverifyInitTerms`), so a row whose
--     ledger row lands a moment later converges, and an extended value never
--     becomes backed.
-- `LoanInitiatedDetails` ledger rows carry the loan id inside `args_json`
-- (no `loan_id` column ref — the shape 0032 already reads).
--
-- Plain ALTER TABLE ADD COLUMN per the repo idiom; the UPDATE and the indexes
-- are independently idempotent. Additive: the deployed code never reads it.
ALTER TABLE loans ADD COLUMN init_terms_unbacked INTEGER NOT NULL DEFAULT 1;

-- The lookup both the backfill below and every tick's re-verification make:
-- a details row by its loan id. With the id only inside `args_json`, the
-- planner's best was `idx_activity_chain_kind`, i.e. every details row of
-- the chain per flagged loan — and a loan whose terms the ledger never
-- carries stays flagged, so that cost would recur on every tick and grow
-- with the ledger (#2478 r1). A partial expression index on exactly the
-- expression the queries compare makes it one probe. Partial on the kind so
-- it covers only these rows; created before the backfill so that uses it
-- too. (`loan_id` stays NULL on these rows by design — see
-- DELIBERATELY_NOT_SCOPED in scripts/lib/activity-refs-surface.mjs.)
CREATE INDEX IF NOT EXISTS idx_activity_initiated_details_loan
  ON activity_events(chain_id, CAST(json_extract(args_json, '$.loanId') AS INTEGER))
  WHERE kind = 'LoanInitiatedDetails';

UPDATE loans
   SET init_terms_unbacked = 0
 WHERE init_rate_bps IS NOT NULL
   AND init_duration_days IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id
        AND ae.kind = 'LoanInitiatedDetails'
        AND CAST(json_extract(ae.args_json, '$.loanId') AS INTEGER) = loans.loan_id
        AND CAST(json_extract(ae.args_json, '$.details.interestRateBps') AS INTEGER) = loans.init_rate_bps
        AND CAST(json_extract(ae.args_json, '$.details.durationDays') AS INTEGER) = loans.init_duration_days
   );

CREATE INDEX IF NOT EXISTS idx_loans_init_terms_unbacked
  ON loans(chain_id) WHERE init_terms_unbacked = 1;
