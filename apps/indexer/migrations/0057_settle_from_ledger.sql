-- #2464 — re-project loans the chain has settled but the indexer has not.
--
-- The `LoanSettled` handler used to settle a row only from `repaid`,
-- `defaulted` or `liquidated`. An internally matched loan settles on chain
-- when its claims clear (spec: Internal-Match Incentive and Surplus
-- Handling), and the `LoanStatusChanged` edge handler leaves terminal →
-- Settled to `LoanSettled` on purpose, so those rows stayed
-- `internal_matched` after settling (Base Sepolia loans 24–27, 2026-10-13).
-- The handler now treats the event as authoritative; this applies the same
-- rule to rows indexed before it.
--
-- Source of truth: the append-only activity ledger. A row is settled here
-- only if the ledger holds a `LoanSettled` for that chain and loan, and its
-- terminal block and time are that event's own, never "now".
--
-- Data-only and idempotent (a second run finds no unsettled row with the
-- event). Additive with respect to the deployed code, which already treats
-- `settled` as the terminal claims-resolved status.
UPDATE loans
   SET status = 'settled',
       terminal_block = (
         SELECT ae.block_number FROM activity_events ae
          WHERE ae.chain_id = loans.chain_id AND ae.loan_id = loans.loan_id AND ae.kind = 'LoanSettled'
          ORDER BY ae.block_number ASC, ae.log_index ASC LIMIT 1),
       terminal_at = (
         SELECT ae.block_at FROM activity_events ae
          WHERE ae.chain_id = loans.chain_id AND ae.loan_id = loans.loan_id AND ae.kind = 'LoanSettled'
          ORDER BY ae.block_number ASC, ae.log_index ASC LIMIT 1),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE status <> 'settled'
   AND EXISTS (
     SELECT 1 FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id AND ae.loan_id = loans.loan_id AND ae.kind = 'LoanSettled'
   );
