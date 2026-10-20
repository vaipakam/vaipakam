-- apps/keeper/migrations/0005_keeper_horizon.sql
--
-- The reward claim-horizon heartbeat's private state (#2517, #1956),
-- keeper-private. Additive, like every keeper migration.
--
-- An entry's horizon clock advances only when something touches it
-- (`sweepExpiredInteractionRewards`, permissionless), and an interval between
-- two touches counts only when it is no longer than the contract's maximum
-- observation gap. The keeper is what touches it, so it needs to know which
-- entries are still live and when it last touched each one.

-- The heartbeat's ENTRY queue. Each live reward entry is discovered once, in
-- id order (entry ids are allocated sequentially from 1), and leaves only when
-- an on-chain read shows it settled (claimed, expired, or forfeited — a
-- forfeited entry belongs to the forfeit sweep and never expires). Namespaced
-- by Diamond, like keeper_work_open: a fresh redeploy counts its ids from 1
-- again.
--
--   checked_at  when the pass last finished with the entry: a touch that
--               landed, or a read that showed nothing to send (the horizon is
--               dark and the entry has not begun expiring). It orders the work
--               and decides what is due. A touch that does NOT land leaves it,
--               so the entry is retried on the next run, not a heartbeat later.
--   touched_at  when a sweep including the entry last LANDED (0 = never). What
--               the "touches are not landing" alert measures.
--   expires_at  the contract's removal estimate (`getRewardEntryExpiry`), read
--               just before the last landed touch (0 = no countdown then). The
--               estimate stands still while the clock advances and moves
--               forward while it is paused, so comparing it across two touches
--               is how the pass sees a clock that did not advance.
--   paused_runs consecutive landed touches across which the estimate moved
--               forward (the clock did not advance). Reset by one that did.
CREATE TABLE IF NOT EXISTS keeper_horizon_entry (
  chain_id    INTEGER NOT NULL,
  diamond     TEXT    NOT NULL,  -- lowercased
  entry_id    INTEGER NOT NULL,
  checked_at  INTEGER NOT NULL DEFAULT 0,  -- unix seconds; 0 = never
  touched_at  INTEGER NOT NULL DEFAULT 0,  -- unix seconds; 0 = never
  expires_at  INTEGER NOT NULL DEFAULT 0,  -- unix seconds; 0 = no countdown
  paused_runs INTEGER NOT NULL DEFAULT 0,
  added_at    INTEGER NOT NULL,            -- unix seconds
  PRIMARY KEY (chain_id, diamond, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_keeper_horizon_entry_due
  ON keeper_horizon_entry (chain_id, diamond, checked_at, entry_id);

-- The heartbeat's DISCOVERY cursor: the first entry id not yet read. It moves
-- forward only, past entries already queued or already settled, and never past
-- the end of the allocated sequence (a zeroed entry), so an entry allocated
-- later is read when it exists. Disposable: an empty table restarts discovery
-- at id 1, and re-queuing an entry already queued is a no-op.
CREATE TABLE IF NOT EXISTS keeper_horizon_cursor (
  chain_id      INTEGER NOT NULL,
  diamond       TEXT    NOT NULL,  -- lowercased
  next_entry_id INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,  -- unix seconds
  PRIMARY KEY (chain_id, diamond)
);
