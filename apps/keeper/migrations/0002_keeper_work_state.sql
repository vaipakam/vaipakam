-- apps/keeper/migrations/0002_keeper_work_state.sql
--
-- Keeper-private state added in #2489 (Codex rounds 1 and 2). Additive, like
-- every keeper migration: it lands while the previous keeper is still serving.

-- The keeper's DONE set. A pass that finds its work in the shared event log
-- (the delivery-proof pass: budget deliveries; the remit-ack pass: released
-- reservations whose delivery may still land) reads EVERY candidate the log
-- holds and skips the ones recorded here. An item is recorded only when an
-- on-chain read shows it finished, so it stays a candidate until the chain
-- says it is done, never until it ages out of a window or a row count. The
-- earlier passes read the last 45 days, or the newest 50 releases, and a
-- delivery still waiting on its proof past either bound dropped out for good.
--
-- Keyed by the Diamond as well as the chain: a fresh redeploy restarts the ids
-- a pass records (remit ids count from 1 again). `item` is the pass's own id:
-- a packet hash (lowercase hex) or a remit id (decimal).
CREATE TABLE IF NOT EXISTS keeper_work_done (
  chain_id INTEGER NOT NULL,
  diamond  TEXT    NOT NULL,
  kind     TEXT    NOT NULL,  -- 'delivery_proof' | 'late_ack'
  item     TEXT    NOT NULL,
  done_at  INTEGER NOT NULL,  -- unix seconds
  PRIMARY KEY (chain_id, diamond, kind, item)
);

-- The sanctions-hold pass's SCREEN cursor (Codex #2489 r2). A wallet flagged
-- while it holds ordinary (unstaged) reward leaves no trace the pass could
-- find: its claim's observation reverts with the claim, so there is no
-- evidence event and no staging record. So the pass screens every loan party
-- through the contract's classifier, a bounded slice each tick, sized to cover
-- them all within a day; this is where the slice resumes. `cursor` is the last
-- address screened (lowercase), '' to start over. Disposable: an empty table
-- restarts the screen from the first address.
CREATE TABLE IF NOT EXISTS keeper_sanctions_screen (
  chain_id   INTEGER NOT NULL,
  diamond    TEXT    NOT NULL,
  cursor     TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,  -- unix seconds
  PRIMARY KEY (chain_id, diamond)
);

-- The one-time cutover copy's completion record (DeploymentRunbook, "Keeper
-- private D1 — one-time cutover"). `scripts/keeper-cutover.mjs` writes it, and
-- only after every one of the five moved tables has the same fingerprint (row
-- count and latest write time) on both sides. `fingerprint` is that JSON, read
-- from the SHARED copies. The keeper's deploy refuses to publish while the
-- shared copies hold rows and this record is missing, or no longer matches
-- them (a keeper wrote the old copies after the copy). One row at most.
CREATE TABLE IF NOT EXISTS keeper_cutover (
  id           INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  completed_at INTEGER NOT NULL,  -- unix seconds
  fingerprint  TEXT    NOT NULL
);
