-- #2461 (Codex rounds 1-4) — whether a loan's `init_principal` is backed by
-- the chain's own initiation record, kept beside the value and never by
-- changing it.
--
-- 0032 backfilled `init_principal` for loans indexed before it, preferring
-- the original `LoanInitiated` payload in the append-only activity ledger
-- and, where no such row existed, FALLING BACK to the mutable `principal`.
-- Two readers now use the column, and they need different things:
--   - the rate candles read `COALESCE(init_principal, principal)` as a
--     FROZEN fill size. A fallback copy is the best figure they will ever
--     have and must stay frozen, or a later partial repayment or match would
--     shrink a historical fill retroactively.
--   - the app shows `initPrincipal` as what a loan was initiated with
--     (#2453). There a copy of an already-reduced principal would present
--     the remainder as history.
-- So the value stays, and `init_principal_unbacked` says whether it is
-- substantiated. The loan routes serve a flagged row's `initPrincipal` as
-- null (the app says the amount is not available); the candles ignore it.
--
-- The flag is DERIVED, not trusted from the writer:
--   - DEFAULT 1. A row is withheld until something vouches for it. That
--     matters because the deploy applies migrations BEFORE it publishes the
--     new Worker (apps/indexer/scripts/deploy-shared-d1.mjs), so the
--     previous Worker keeps inserting rows in between — including through a
--     path that could stamp a chain-head (possibly already reduced) read.
--   - The current insert paths stamp 0 explicitly: each takes the value from
--     the `LoanInitiated` event itself.
--   - Every indexer tick clears the flag wherever the ledger confirms the
--     value (`reverifyInitPrincipal`), so a row written in the deploy gap,
--     or one whose ledger row lands a moment after it, converges — and a
--     value the ledger does not carry never becomes backed.
-- The one-shot UPDATE below does the first pass of that re-verification for
-- every existing row. Additive with respect to the deployed code, which
-- never reads the column.
--
-- Plain ALTER TABLE ADD COLUMN is the repo's 0006/0012/0029/0032 idiom and
-- relies on wrangler's ledger applying this file exactly once; the UPDATE
-- and the index are independently idempotent.
ALTER TABLE loans ADD COLUMN init_principal_unbacked INTEGER NOT NULL DEFAULT 1;

UPDATE loans
   SET init_principal_unbacked = 0
 WHERE init_principal IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id
        AND ae.loan_id  = loans.loan_id
        AND ae.kind = 'LoanInitiated'
        AND json_extract(ae.args_json, '$.principal') = loans.init_principal
   );

-- The per-tick re-verification only ever looks at flagged rows; keep that a
-- probe of a (normally empty) partial index rather than a table scan.
CREATE INDEX IF NOT EXISTS idx_loans_init_principal_unbacked
  ON loans(chain_id) WHERE init_principal_unbacked = 1;
