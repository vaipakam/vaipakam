-- #2476 r12 — an EXPLICIT marker for a terminal state the reconciliation
-- repair wrote, as opposed to one an event (or the ledger heal) wrote.
--
-- The repair's inbox notice ("we found this by checking") must be written
-- only when THIS pass's compare-and-set won. D1 offers no way to condition a
-- statement in a batch on the previous statement's result, so the notice
-- self-gates on what the repair leaves on the row. That used to be inferred
-- from the row's shape (a NULL terminal time, then a NULL terminal block as
-- well), and each inference was broken by a legitimate writer producing the
-- same shape. This column is set to 1 only by the repair's UPDATE and to 0 by
-- every other terminal writer, so the notice no longer infers.
--
-- Additive: DEFAULT 0, and the deployed code neither reads nor writes it.
-- Plain ALTER TABLE ADD COLUMN per the repo idiom.
ALTER TABLE loans ADD COLUMN terminal_by_repair INTEGER NOT NULL DEFAULT 0;

-- #2476 r13 — the ledger heal also revisits SETTLED rows whose terminal block
-- or time is still unknown, to fill them once the chain can substantiate
-- them. A partial index keeps that a probe of the (normally tiny) set rather
-- than a walk over every settled loan.
CREATE INDEX IF NOT EXISTS idx_loans_settled_unknown_provenance
  ON loans(chain_id, loan_id)
  WHERE status = 'settled' AND (terminal_block IS NULL OR terminal_at IS NULL);

-- #2476 r14 — settlement times the previous Worker made up. Its LoanSettled
-- handler stored the SCAN's wall clock as `terminal_at` (correct block, wrong
-- time), so every row it settled presents when the indexer noticed the
-- settlement as when it happened. Those times are marked UNKNOWN here, never
-- rewritten from a guess: the ledger heal revisits a settled row whose time is
-- unknown and, when the ledgered event is confirmed on chain, fills it from a
-- fresh read of that block. Scope: rows with a known block and a ledgered
-- LoanSettled — exactly what that handler wrote. Repair-settled rows (NULL
-- block) and rows without a ledgered event are untouched.
--
-- Data-only and compatible with the deployed code, whose readers already
-- tolerate a NULL terminal_at (a repaired row carries one). Like the ALTER
-- above, it relies on wrangler's ledger applying this file exactly once.
UPDATE loans
   SET terminal_at = NULL
 WHERE status = 'settled'
   AND terminal_block IS NOT NULL
   AND terminal_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM activity_events ae
      WHERE ae.chain_id = loans.chain_id AND ae.loan_id = loans.loan_id
        AND ae.kind = 'LoanSettled'
   );
