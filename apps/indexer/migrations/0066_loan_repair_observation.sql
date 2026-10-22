-- #2195 (ledger half) — what a reconciliation repair OBSERVED, kept on the
-- loan row so the Activity feed can show a repaired loan's ending.
--
-- A repair (#2101) closes a loan whose terminal event the indexer missed for
-- good. `activity_events` is an index of LOGS, keyed by (block, log_index),
-- and a repaired terminal has no log: a synthesized row there would claim an
-- event at a position the chain never emitted one. So the observation lives
-- here instead, and the feed serves it as its own entry type that says what
-- it is: "the chain showed this loan ended by this block" — never when it
-- ended, and never which event ended it.
--
--   repair_observed_status — the terminal status the chain read showed.
--   repair_observed_block  — the settled block that read was pinned to: the
--                            loan had ended BY then. Positions the entry in
--                            the feed; it is not the ending's block.
--   repair_observed_at     — that block's chain time (NULL when not read).
--
-- Written ONLY by the repair's own compare-and-set UPDATE, in the same
-- statement as the status, and never cleared: a later settlement does not
-- un-observe it. A withdrawn orphan takes it with the row.
--
-- Additive: three NULLable columns and a partial index; the deployed code
-- neither reads nor writes them. Plain ALTER TABLE ADD COLUMN per the repo
-- idiom. Rows repaired before this migration carry NULL and are not shown:
-- the block their repair read was not recorded, and is not invented here.
ALTER TABLE loans ADD COLUMN repair_observed_status TEXT;
ALTER TABLE loans ADD COLUMN repair_observed_block INTEGER;
ALTER TABLE loans ADD COLUMN repair_observed_at INTEGER;

-- The feed's merge walks repaired loans newest-observed first, per chain.
CREATE INDEX IF NOT EXISTS idx_loans_chain_repair_observed
  ON loans(chain_id, repair_observed_block DESC, loan_id DESC)
  WHERE repair_observed_block IS NOT NULL;
