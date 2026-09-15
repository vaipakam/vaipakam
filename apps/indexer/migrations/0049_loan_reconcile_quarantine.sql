-- Loans the reconciliation pass looked at and could NOT settle (#2212).
--
-- The pass compares stored loan rows against the chain and can fail to settle
-- a row four ways: the chain has never heard of it, its status could not be
-- read, its repair write failed, or it carries a status this build cannot
-- project. Each of those rows is still stored as `active`, which is exactly
-- what a permanently missed terminal leaves behind — so anything deriving
-- user-facing consequences from "this loan is active" must leave them out.
--
-- WHY A TABLE AND NOT THE PASS'S OWN REPORT. #2211 withheld such rows from
-- the reminder sweep using the CURRENT pass's report, which narrowed the
-- window without closing it: the rotation examines one or three rows a turn,
-- so on the next turn the row is not in the report, the exclusion is empty
-- for its id, and the unretractable reminder is minted anyway.
--
-- The aliasing is the defect — "what this pass examined" is not "what is
-- currently unsettled" — and any fix reading only the current pass carries
-- it, including the cruder one of deferring the whole sweep whenever the
-- report is dirty. What is needed is memory that outlives the pass that found
-- the row, which is this.
CREATE TABLE IF NOT EXISTS loan_reconcile_quarantine (
  chain_id INTEGER NOT NULL,
  loan_id INTEGER NOT NULL,

  -- WHICH of the four, kept rather than flattened to a flag. They need
  -- different operator actions: an unreadable row points at the RPC, a failed
  -- write at D1, an unprojectable status at a build that is behind the
  -- contracts, and an orphan at a row that needs a person. Flattening them
  -- would reproduce, in the operator's view, the same "something is wrong"
  -- silence the reconciliation diagnostics exist to end.
  reason TEXT NOT NULL,

  -- WHEN IT WAS FIRST SEEN UNSETTLED, preserved across re-observations. This
  -- is the operator's signal: a row quarantined for minutes is a transient
  -- read failure, one quarantined for days is a ghost nobody has resolved.
  -- An upsert that reset this on every observation would erase exactly the
  -- fact worth knowing.
  first_seen_at INTEGER NOT NULL,

  -- The most recent pass that re-observed it unsettled. `first_seen_at` with
  -- `last_seen_at` distinguishes a row still failing from one whose entry is
  -- stale because the rotation has not reached it again yet.
  last_seen_at INTEGER NOT NULL,

  PRIMARY KEY (chain_id, loan_id)
);

-- The read this exists for: "which loans on this chain are quarantined?",
-- asked by every surface that would otherwise act on a stored `active` row.
CREATE INDEX IF NOT EXISTS idx_loan_quarantine_chain
  ON loan_reconcile_quarantine(chain_id, loan_id);
