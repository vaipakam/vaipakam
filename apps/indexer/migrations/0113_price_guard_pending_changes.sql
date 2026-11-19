-- #3453 — the price guard's pending changes, and how far back the indexer
-- has read the guard's logs.
--
-- The pricing settings live on the standalone price guard (#3272 part 2). A
-- change to one is proposed, waits the guard's delay, and only then may be
-- executed; the delay is the review window, so the console must show each
-- change while it waits. The indexer now reads the guard's logs beside the
-- Diamond's and keeps here every change the guard announced with
-- `ChangeProposed` (or, for a secondary source's removal,
-- `SecondaryRemovalProposed`) and has not yet executed or cancelled.
--
-- `kind` is the guard's `Kind` ordinal, or 255 for a secondary source's
-- removal, which the guard keeps outside its change map. `subject` and
-- `value` are the raw 32-byte words. Rows are derived from the chain alone:
-- a block-zero replay rebuilds them, so the restore runbook clears them.
CREATE TABLE IF NOT EXISTS price_guard_pending_changes (
  chain_id        INTEGER NOT NULL,
  guard           TEXT    NOT NULL,   -- lower-case guard address
  kind            INTEGER NOT NULL,
  subject         TEXT    NOT NULL,   -- 0x-prefixed 32-byte hex
  value           TEXT    NOT NULL,   -- 0x-prefixed 32-byte hex
  executable_at   INTEGER NOT NULL,   -- unix seconds
  proposed_block  INTEGER NOT NULL,
  PRIMARY KEY (chain_id, guard, kind, subject)
);

-- The guard the indexer reads, per chain, and the first block it read that
-- guard's logs from. A change proposed before that block is not in the table
-- above, so the route says the list is complete only from this block on.
CREATE TABLE IF NOT EXISTS price_guard_watch (
  chain_id    INTEGER PRIMARY KEY,
  guard       TEXT    NOT NULL,
  registry    TEXT,
  from_block  INTEGER NOT NULL
);
