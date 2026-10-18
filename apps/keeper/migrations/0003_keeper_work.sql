-- apps/keeper/migrations/0003_keeper_work.sql
--
-- The keeper's open-work queue and its discovery cursor (#2489, #2497 r8),
-- keeper-private. Additive, like every keeper migration.

-- The keeper's OPEN-WORK queue (#2489, restructured in #2497 r8). A pass
-- that finds its work in the shared event log (the delivery-proof pass: budget
-- deliveries; the remit-ack pass: released reservations whose delivery may
-- still land) DISCOVERS each item once, into this table, with a cursor that
-- only moves forward (`keeper_work_cursor`, below). An item leaves only when an on-chain
-- read shows it finished, so it stays work until the chain says it is done,
-- never until it ages out of a window or a row count. Neither the discovery
-- read nor the work read grows with history: the first is a page past the
-- cursor, the second a bounded slice of what is still open — and no item that
-- can never finish holds anything else back.
--
-- Keyed by the Diamond as well as the chain: a fresh redeploy restarts the ids
-- a pass records (remit ids count from 1 again). `item` is the pass's own id:
-- a packet hash (lowercase hex) or a remit id (decimal). `payload` is what the
-- pass needs to work the item without re-reading the ledger (JSON).
-- `checked_at` rotates the work slice: the least recently checked first.
CREATE TABLE IF NOT EXISTS keeper_work_open (
  chain_id   INTEGER NOT NULL,
  diamond    TEXT    NOT NULL,
  kind       TEXT    NOT NULL,  -- 'delivery_proof' | 'late_ack'
  item       TEXT    NOT NULL,
  block      INTEGER NOT NULL,  -- the ledger block it was discovered at
  payload    TEXT    NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0,  -- unix seconds; 0 = never
  added_at   INTEGER NOT NULL,            -- unix seconds
  PRIMARY KEY (chain_id, diamond, kind, item)
);
CREATE INDEX IF NOT EXISTS idx_keeper_work_open_rotation
  ON keeper_work_open (chain_id, diamond, kind, checked_at, block);

-- #2497 r8 — the DISCOVERY cursor of an open-work pass, keeper-private.
--
-- `next_block` is the first ledger block the pass has not yet discovered work
-- in: every item at a block below it is already in keeper_work_open (above),
-- or was, and has finished. It moves forward only — past a page the
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
