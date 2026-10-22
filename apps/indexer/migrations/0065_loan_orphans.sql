-- #2197 — loan rows the chain has no loan for, WITHDRAWN from publication.
--
-- A row is proven an orphan when the chain, read at the settled head, answers
-- `getLoanDetails` with the zero struct (id 0): a row indexed once from
-- something later undone (say a `LoanInitiated` from a block that was
-- reorganised away). Two lanes read every candidate that way: the
-- reconciliation pass (live rows) and the settlement heal (ended rows), and
-- both make the same move through one helper (src/loanOrphans.ts). Until #2197 such a row was only REPORTED:
-- it kept its `active` status, so every surface that lists loans went on
-- publishing a position that does not exist, and the rotation spent a slot on
-- it every lap.
--
-- The row is now MOVED here, in one transaction with the delete from
-- `loans` (and the loan's side tables), every statement under one
-- compare-and-set so a concurrent writer leaves all of them no-ops. Moving rather than restatusing is the
-- point: every reader of `loans` — four Workers and every route — stops
-- seeing it with no filter added anywhere, where a new status value would
-- have had to be excluded, deliberately, at every site that lists loans.
--
-- WHY THE ROW IS KEPT, and as JSON. The move must be reversible: a row
-- withdrawn because of a fault in the existence test would otherwise be
-- unrecoverable. `row_json` is the whole `loans` row exactly as it stood,
-- column for column, so an operator can put it back: re-insert the row from
-- `row_json` into `loans`, delete it from here, and clear the
-- `loan_reconcile_quarantine` marker for the id. JSON rather than a
-- copy of the `loans` columns, because a column later added to `loans` would
-- otherwise have to be added here too, and a copy that drifted would make
-- the restore lossy.
--
-- RESTORE TREATMENT: archived nightly and restored from the archive
-- (born-off-chain), never cleared for the replay — a replay cannot recreate a
-- row whose initiation is not in canonical history, so this table is the only
-- record of what was withdrawn (docs/ops/OffChainRestore.md §4). A fresh
-- Diamond on a chain resets it with every other loan-keyed row
-- (src/deploymentEpoch.ts): its ids would otherwise be read against the new
-- Diamond's restarted ones. The retired deployment's entries stay in the
-- archives taken before.
--
-- Where the reconciliation pass made the move, the quarantine marker
-- (`loan_reconcile_quarantine`, reason `orphan`) is deliberately NOT cleared: with no `loans` row it is held
-- indefinitely and named in the operator's stale report, which is where a
-- person learns a position was withdrawn. Nothing on a public surface says
-- so, because nothing on a public surface ever existed on chain.
--
-- Additive: a new table; the deployed code neither reads nor writes it.
CREATE TABLE IF NOT EXISTS loan_orphans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  loan_id INTEGER NOT NULL,
  -- The live status the row carried when it was withdrawn.
  from_status TEXT NOT NULL,
  -- The settled head the existence read was pinned to: the evidence.
  observed_block INTEGER NOT NULL,
  -- Wall clock of the move (seconds). When the PLATFORM acted, not when
  -- anything happened on chain.
  withdrawn_at INTEGER NOT NULL,
  -- The whole `loans` row as it stood, for the operator's restore.
  row_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loan_orphans_chain_loan ON loan_orphans (chain_id, loan_id);
