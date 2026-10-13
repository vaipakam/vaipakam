-- #2461 (Codex rounds 1-2) — mark the `init_principal` values the chain's own
-- initiation record does not back, without touching them.
--
-- 0032 backfilled `init_principal` for loans indexed before it, preferring
-- the original `LoanInitiated` payload in the append-only activity ledger
-- and, where no such row existed, FALLING BACK to the mutable `principal`.
-- Two readers now use the column, and they need different things:
--   - the rate candles read `COALESCE(init_principal, principal)` as a
--     FROZEN fill size. A fallback copy is the best figure they will ever
--     have, and it must stay frozen: clearing it would let a later partial
--     repayment or match shrink a historical fill retroactively.
--   - the app shows `initPrincipal` as what a loan was initiated with
--     (#2453). There a fallback copy of an already-reduced principal would
--     present the remainder as history.
-- So the value stays, and this flag says whether it is substantiated. The
-- loan routes serve `initPrincipal` as null for a flagged row (the app then
-- says the amount is not available); the candles ignore the flag.
--
-- Who is flagged: a row whose `init_principal` no `LoanInitiated` ledger row
-- for the same chain and loan carries exactly. Every insert path since 0032
-- stamps the column from that event, which also lands in the ledger, and no
-- mutation handler writes it — so nothing written after this migration needs
-- the flag, and the DEFAULT 0 is correct for the code deployed both before
-- and after it (additive, expand-only). Stated rather than hidden: a loan
-- whose ledger row is missing for any other reason, or one indexed in the
-- moment this runs with its ledger row not yet written, is flagged too and
-- reads "not available" — the honest direction, never a wrong figure.
--
-- Plain ALTER TABLE ADD COLUMN is the repo's 0006/0012/0029/0032 idiom and
-- relies on wrangler's ledger applying this file exactly once; the UPDATE is
-- independently idempotent.
ALTER TABLE loans ADD COLUMN init_principal_unbacked INTEGER NOT NULL DEFAULT 0;

UPDATE loans
   SET init_principal_unbacked = 1
 WHERE init_principal IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id
        AND ae.loan_id  = loans.loan_id
        AND ae.kind = 'LoanInitiated'
        AND json_extract(ae.args_json, '$.principal') = loans.init_principal
   );
