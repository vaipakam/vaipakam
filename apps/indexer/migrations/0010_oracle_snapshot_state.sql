-- 0010_oracle_snapshot_state.sql
--
-- AnalyticalGettersDesign §3.4 (D9–D10) — per-chain bookkeeping
-- for the daily oracle-snapshot keeper. The on-chain ring buffer
-- in `s.assetPriceSnapshots[asset][dayIndex]` is permissionless
-- and idempotent (silent-skip on already-captured days), but the
-- watcher tracks the last successful day index per chain so it
-- doesn't waste an RPC + signing round-trip every cron tick once
-- the day's slot is already populated.

CREATE TABLE IF NOT EXISTS oracle_snapshot_state (
  chain_id   INTEGER PRIMARY KEY,
  -- block.timestamp / 86400 of the most recent successful capture
  -- inclusion (waited for receipt). Reset only on schema drop.
  day_index  INTEGER NOT NULL,
  -- ms-since-epoch of the worker's last successful pass; purely
  -- for ops debugging / staleness detection.
  updated_at INTEGER NOT NULL
);
