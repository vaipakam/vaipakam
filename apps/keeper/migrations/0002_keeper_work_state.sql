-- apps/keeper/migrations/0002_keeper_work_state.sql
--
-- Keeper-private state added in #2489 (Codex rounds 1 and 2). Additive, like
-- every keeper migration: it lands while the previous keeper is still serving.

-- The keeper's OPEN-WORK queue (#2489, restructured in #2497 r8). A pass
-- that finds its work in the shared event log (the delivery-proof pass: budget
-- deliveries; the remit-ack pass: released reservations whose delivery may
-- still land) DISCOVERS each item once, into this table, with a cursor that
-- only moves forward (migration 0003). An item leaves only when an on-chain
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

-- The sanctions-hold pass's WATCH list (#2497 r11). An owner the screen finds
-- held or confirmed may leave no other trace yet — no evidence event, no
-- staging record — until its first observation lands. So the screen records it
-- here, and it stays a candidate every tick until a fresh read shows nothing
-- left to do (Deliver, with no chain or marker stored). The screen's cursor is
-- then free to move on whatever the tick's sends did: discovery is separate
-- from completion, as in keeper_work_open. Namespaced by Diamond.
CREATE TABLE IF NOT EXISTS keeper_sanctions_watch (
  chain_id   INTEGER NOT NULL,
  diamond    TEXT    NOT NULL,
  owner      TEXT    NOT NULL,  -- lowercase
  added_at   INTEGER NOT NULL,  -- unix seconds
  PRIMARY KEY (chain_id, diamond, owner)
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
