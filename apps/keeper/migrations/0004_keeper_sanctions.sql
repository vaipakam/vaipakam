-- apps/keeper/migrations/0004_keeper_sanctions.sql
--
-- The sanctions-hold pass's private state (#2450, #2489, #2497), keeper-private.
-- Additive, like every keeper migration.

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

-- ── Ops-alert de-duplication (#2450) ──────────────────────────────────────
--
-- The keeper's reward passes raise OPERATOR alerts (the ops bot,
-- `TG_OPS_BOT_TOKEN`, never the user-facing one): the first is the #1566
-- sanctions-hold observer (apps/keeper/src/rewardSanctionsHold.ts). A pass
-- runs every few minutes and the condition it reports usually persists for
-- hours, so without a record of what was already sent the operator chat would
-- get the same line on every tick.
--
-- One row per alert KEY (a pass-chosen string naming the condition and its
-- subject, e.g. `sanctions-hold-overdue:<chainId>:<owner>`). `first_seen_at`
-- is when the condition was first reported, `last_sent_at` when it was last
-- delivered; a pass re-sends only after its own minimum interval.
--
-- Disposable state: losing it re-sends at most one line per live condition and
-- changes nothing on chain, so a restore may simply start it empty.
CREATE TABLE IF NOT EXISTS keeper_ops_alert (
  alert_key     TEXT    NOT NULL PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_sent_at  INTEGER NOT NULL,
  -- The chain an alert is about, or NULL for one that is not chain-scoped
  -- (#2497 r10). A column, not a key convention, so the keeper's deployment-
  -- epoch reset (src/keeperEpoch.ts) finds it by the same schema rule as every
  -- other keyed-by-chain table: a redeploy forgets the retired Diamond's de-dup.
  chain_id      INTEGER
);
