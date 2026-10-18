-- #2497 r8 — the DISCOVERY cursor of an open-work pass, keeper-private.
--
-- `next_block` is the first ledger block the pass has not yet discovered work
-- in: every item at a block below it is already in keeper_work_open (migration
-- 0002), or was, and has finished. It moves forward only — past a page the
-- pass has enqueued, and never past the block the shared indexer has
-- completely recorded (its `diamond` cursor, read before the page). It never
-- waits on an open item: that is the queue's job, which is what lets an item
-- that never finishes sit in the queue without pinning the read.
--
-- Disposable: an empty table starts discovery at the active Diamond's deploy
-- block, and re-discovering an item already queued is a no-op.
CREATE TABLE IF NOT EXISTS keeper_work_cursor (
  chain_id   INTEGER NOT NULL,
  diamond    TEXT    NOT NULL,          -- lowercased, like keeper_work_open
  kind       TEXT    NOT NULL,          -- 'delivery_proof' | 'late_ack'
  next_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,          -- unix seconds
  PRIMARY KEY (chain_id, diamond, kind)
);
