-- #2461 (Codex round 1, P2) — keep `init_principal` to what the chain
-- recorded.
--
-- 0032 backfilled `init_principal` for loans indexed before it, preferring
-- the original `LoanInitiated` payload in the append-only activity ledger
-- and, where no such row existed, FALLING BACK to the mutable `principal`.
-- That fallback was fine for 0032's consumer — the rate candles read
-- `COALESCE(init_principal, principal)`, so a fallback copy and a NULL give
-- the candles the same number. It is not fine now that the app shows
-- `initPrincipal` as what a loan was initiated with (#2453): for a legacy
-- loan already partly repaid or matched, the fallback copy is the
-- remainder, presented as history.
--
-- So a value the ledger does not substantiate is withdrawn: NULL is the
-- column's documented "unknown", and the app then says the amount is not
-- available instead of stating a figure. Every insert path since 0032
-- stamps the column from the `LoanInitiated` event, and that event also
-- lands in the ledger, so a current loan keeps its value.
--
-- Stated, not hidden:
--   - A loan whose ledger row is missing for any other reason (an activity
--     write that failed) also reads unknown — the direction this rule
--     prefers, since the figure cannot be substantiated.
--   - A loan indexed in the moments this migration runs, whose loans row
--     has landed but whose ledger row has not, reads unknown too. Nothing
--     re-stamps it (only stub rows are healed), and that is accepted: it is
--     an honest "not available", never a wrong figure.
--   - The candles are unaffected: COALESCE(NULL, principal) is the same
--     value the fallback had copied.
--
-- Data-only and idempotent: a re-run finds nothing more to clear. Additive
-- with respect to the deployed code, which already treats NULL as unknown.
UPDATE loans
   SET init_principal = NULL
 WHERE init_principal IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id
        AND ae.loan_id  = loans.loan_id
        AND ae.kind = 'LoanInitiated'
        AND json_extract(ae.args_json, '$.principal') = loans.init_principal
   );
