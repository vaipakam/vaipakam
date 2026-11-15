-- #3677 — which wallets each activity row concerns, so `/activity?wallet=`
-- can serve one wallet's history from the server instead of a client paging
-- the whole chain's feed and keeping the rows that are its own.
--
-- 1. `activity_participants` — one row per (event, wallet) the shared rule
--    names (`@vaipakam/lib/activityParticipants`: the actor plus the further
--    parties each event kind lists). Written at ingest beside the event row,
--    and for history already ingested by the one-time backfill below. The
--    rows a wallet sees because they concern ITS LOANS are a second leg read
--    through `loan_participants`, so they need no row here.
CREATE TABLE IF NOT EXISTS activity_participants (
  chain_id     INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  wallet       TEXT    NOT NULL,             -- lowercase 0x-40-hex
  PRIMARY KEY (chain_id, wallet, block_number, log_index)
);

-- 2. How far the one-time backfill has filled the table from the events
--    already stored: it walks `activity_events` oldest first, one bounded page
--    per pass, and records the last position it reached. `done` = 1 once it
--    has read past the newest stored event, from when every event (old ones
--    by the backfill, new ones at ingest) has its participants. Until then
--    `/activity?wallet=` says its answer may be incomplete.
CREATE TABLE IF NOT EXISTS activity_participants_state (
  chain_id      INTEGER PRIMARY KEY,
  through_block INTEGER NOT NULL DEFAULT -1,
  through_log   INTEGER NOT NULL DEFAULT -1,
  done          INTEGER NOT NULL DEFAULT 0
);

-- 3. The pending lane's own copy (#3411): its rows are rewritten on every
--    read and never reach `activity_events`, so each carries its participants
--    inline, as ' 0xabc… 0xdef… ' (a space before and after each), matched
--    with LIKE over at most a hundred rows per chain. NULL on a row written
--    by a build that predates this column, which then matches no wallet.
--
-- Additive: two new tables and a nullable column. The code still serving
-- while this lands names none of them.
ALTER TABLE pending_activity_events ADD COLUMN participants TEXT;
