-- LZ-watcher schema. Three tables, all bookkeeping (no user-facing data):
--
--   lz_alert_state — alert dedup so a bad config persisting across
--                    cron ticks doesn't spam the Telegram channel
--                    every 5 minutes.
--   scan_cursor    — per (chain, scanner) last-scanned block, so the
--                    flow-event scanner doesn't replay history on
--                    every tick.
--   oft_balance_history — optional snapshot trail of (timestamp,
--                    base_locked, sum_mirror_supply, drift) for
--                    post-incident forensics.

-- Idempotency: emit each alert once per (kind, key) on initial
-- transition to bad state, then re-emit only when value changes OR
-- 1 hour elapses since the last emit (whichever first). Recovery
-- transitions clear the row entirely so the next bad event is
-- treated as a fresh first-alert.
CREATE TABLE IF NOT EXISTS lz_alert_state (
  kind             TEXT NOT NULL,    -- 'dvn_count' | 'oft_imbalance' | 'oversized_flow'
  key              TEXT NOT NULL,    -- composite, e.g. 'dvn_count:8453:0xOApp:30110:send'
  last_value       TEXT,             -- last observed offending value (free-form per-kind)
  first_alerted_at INTEGER NOT NULL, -- unix seconds
  last_alerted_at  INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);

-- Per-chain log-scanner cursor. Each scanner advances its own cursor
-- so the flow scanner's progress doesn't reset when a future scanner
-- joins. Reset to 0 to force a full backfill on next tick.
CREATE TABLE IF NOT EXISTS scan_cursor (
  chain_id   INTEGER NOT NULL,
  scanner    TEXT NOT NULL,          -- 'flow' for now; future: 'imbalance_xtx', etc.
  last_block INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, scanner)
);

-- OFT balance snapshots — append-only history of every imbalance check.
-- Lets us correlate a future incident with the gradual drift (if any)
-- leading up to it. Pruned to the last 30 days by a periodic sweep
-- inside the watcher.
CREATE TABLE IF NOT EXISTS oft_balance_history (
  ts                    INTEGER NOT NULL,    -- unix seconds
  base_locked           TEXT NOT NULL,       -- VPFI in adapter on Base, decimal string
  sum_mirror_supply     TEXT NOT NULL,       -- sum across all mirror chains
  drift                 TEXT NOT NULL,       -- locked - sum_mirror, signed decimal
  ok                    INTEGER NOT NULL,    -- 1 if drift==0, else 0
  PRIMARY KEY (ts)
);

CREATE INDEX IF NOT EXISTS idx_lz_alert_state_lastalert ON lz_alert_state(last_alerted_at);
CREATE INDEX IF NOT EXISTS idx_oft_balance_history_ok ON oft_balance_history(ok);
