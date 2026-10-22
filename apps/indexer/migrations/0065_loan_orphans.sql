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
-- `loans`, together with everything else the platform publishes about the
-- loan: its ledger entries (`activity_events`), its participation history
-- (`loan_participants`) and its inbox notifications, each kept whole in
-- `related_json`, and its side tables (`prepay_listings`,
-- `swap_to_repay_intents`), which are commitments to act and are not kept.
-- The archive insert is guarded by the WHOLE row as it was read, column by
-- column, and every later statement acts only if that insert landed, so a
-- concurrent writer that changed anything leaves the whole move a no-op. Moving rather than restatusing is the
-- point: every reader of `loans` — four Workers and every route — stops
-- seeing it with no filter added anywhere, where a new status value would
-- have had to be excluded, deliberately, at every site that lists loans.
--
-- WHY THE ROW IS KEPT, and as JSON. The move must be reversible: a row
-- withdrawn because of a fault in the existence test would otherwise be
-- unrecoverable. `row_json` is the whole `loans` row exactly as it stood,
-- column for column, so an operator can put it back: re-insert the row from
-- `row_json` into `loans` and each `related_json` row into its table
-- (without `orphan_rowid`), delete the entry from here, and clear the
-- `loan_reconcile_quarantine` marker for the id. JSON rather than a
-- copy of the `loans` columns, because a column later added to `loans` would
-- otherwise have to be added here too, and a copy that drifted would make
-- the restore lossy.
--
-- RESTORE TREATMENT: archived nightly and restored from the archive
-- (born-off-chain), never cleared for the replay — a replay cannot recreate a
-- row whose initiation is not in canonical history, so this table is the only
-- record of what was withdrawn (docs/ops/OffChainRestore.md §4). For the
-- same reason a fresh Diamond on a chain does NOT reset it
-- (src/diamondEpochKeep.json): every entry names the Diamond it is about,
-- and nothing joins it to live ids.
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
  -- A fresh random token per move. The batch's later statements act only
  -- once THIS move's archive row exists, so the archive insert's full-row
  -- check is the one compare-and-set the whole move rests on.
  move_id TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  -- The Diamond the existence read was made against. An entry outlives a
  -- fresh Diamond on its chain (src/diamondEpochKeep.json), and this is
  -- what keeps it from being read as being about the new Diamond's ids.
  diamond TEXT NOT NULL,
  loan_id INTEGER NOT NULL,
  -- The live status the row carried when it was withdrawn.
  from_status TEXT NOT NULL,
  -- The settled head the existence read was pinned to: the evidence.
  observed_block INTEGER NOT NULL,
  -- Wall clock of the move (seconds). When the PLATFORM acted, not when
  -- anything happened on chain.
  withdrawn_at INTEGER NOT NULL,
  -- The whole `loans` row as it stood, for the operator's restore.
  row_json TEXT NOT NULL,
  -- Every other published row about the loan, moved out with it, whole:
  -- {"activity_events": [...], "loan_participants": [...],
  --  "notifications": [...]}. Each element is the row as it stood plus its
  -- `orphan_rowid`, the rowid the move deleted.
  related_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loan_orphans_chain_loan ON loan_orphans (chain_id, diamond, loan_id);
