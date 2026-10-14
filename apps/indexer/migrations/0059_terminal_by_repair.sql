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

-- #2476 r15 (root) — an EXPLICIT marker that a settled row's `terminal_at`
-- is the chain's own time for its settlement block, as opposed to anything
-- else a writer may have left there: the previous Worker's LoanSettled
-- handler stored the SCAN's wall clock (correct block, wrong time), a block
-- read that failed leaves it NULL, a repair leaves it NULL. Earlier rounds
-- inferred which was which from the row's shape and each inference broke;
-- a one-shot reset of the legacy rows (r14) also missed any the previous
-- Worker writes between this migration and the new Worker's publish.
--
-- Set to 1 only by `settleLoanRow` when it writes a time read from the chain
-- for a confirmed block; DEFAULT 0, so every existing settled row — legacy
-- scan times included — and every row an older Worker writes later starts
-- unverified. The ledger heal revisits settled rows whose time is unverified
-- and dates them from the chain; the loan routes serve an unverified
-- settlement time as unknown. Nothing is destroyed: the old value stays in
-- the row until a verified one replaces it.
--
-- Additive: DEFAULT 0, and the deployed code neither reads nor writes it.
ALTER TABLE loans ADD COLUMN terminal_at_verified INTEGER NOT NULL DEFAULT 0;

-- The heal's two candidate sets, each seekable by the rotation pointer
-- (#2476 r13, r15): terminal rows by (status, loan_id), and settled rows
-- whose time is unverified by a partial index on exactly that predicate.
CREATE INDEX IF NOT EXISTS idx_loans_chain_status_loan
  ON loans(chain_id, status, loan_id);
CREATE INDEX IF NOT EXISTS idx_loans_settled_unverified
  ON loans(chain_id, loan_id)
  WHERE status = 'settled' AND terminal_at_verified = 0;
