-- #2197 — loan rows the chain has no loan for, WITHDRAWN from publication.
--
-- The reconciliation pass proves a row is an orphan when the chain, read at
-- the settled head, answers `getLoanDetails` with the zero struct (id 0): a
-- row indexed once from something later undone (say a `LoanInitiated` from a
-- block that was reorganised away). Until #2197 such a row was only REPORTED:
-- it kept its `active` status, so every surface that lists loans went on
-- publishing a position that does not exist, and the rotation spent a slot on
-- it every lap.
--
-- The pass now MOVES the row here, in one transaction with the delete from
-- `loans` (and the loan's side tables). Moving rather than restatusing is the
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
-- The quarantine marker (`loan_reconcile_quarantine`, reason `orphan`) is
-- deliberately NOT cleared by the move: with no `loans` row it is held
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
