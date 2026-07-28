-- vaipakam-mesh-alerts-db — schema for the VPFI recycling mesh watcher
-- (#1222 M3 B4-c).
--
-- This database is deliberately SEPARATE from the shared
-- `vaipakam-archive` that apps/{indexer,keeper,agent} bind to. Same
-- trust-boundary rule that gave ops/lz-watcher its own D1: internal ops
-- alerting must not co-locate with user-facing data. Consequently the
-- CLAUDE.md rule that all schema changes land under
-- `apps/indexer/migrations/` does NOT apply here — that rule owns the
-- shared archive's schema, and this file owns this Worker's.

-- Run-length state for the windowed advisory signals. One row per
-- (chain, signal) while a run is building; deleted the moment the
-- condition stops holding, so the table stays O(chains x signals).
CREATE TABLE IF NOT EXISTS streak_state (
  chain_id   INTEGER NOT NULL,
  signal     TEXT    NOT NULL,
  -- The value whose STAYING THE SAME is what the signal is about (a
  -- retirement cumulative, an accepted-report cumulative). Stored as
  -- TEXT: these are uint256 VPFI-wei figures that overflow SQLite's
  -- 64-bit INTEGER.
  marker     TEXT    NOT NULL,
  streak     INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, signal)
);

-- Repeat suppression. `fingerprint` is a hash of the alert body: a
-- condition whose numbers moved re-alerts immediately even inside the
-- quiet window, because that movement is new information.
CREATE TABLE IF NOT EXISTS alert_sent (
  alert_key    TEXT    PRIMARY KEY,
  last_sent_at INTEGER NOT NULL,
  fingerprint  TEXT    NOT NULL
);
