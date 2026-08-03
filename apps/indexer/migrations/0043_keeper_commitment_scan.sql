-- #1222 M3 B2-d1 (Codex #1425 r2) — keeper-owned commitment-report scan
-- state. WRITTEN BY apps/keeper ONLY (the schema lives here because
-- apps/indexer/migrations owns every table on the shared vaipakam-warm
-- D1 — see "Cloudflare D1 schema discipline" in CLAUDE.md).
--
-- Why this exists: the commitment-report pass walks the mirror chain's
-- global reward-entry id sequence per (day, side). The ON-CHAIN cursor only
-- advances on submissions, so an arbitrarily long run of non-covering ids
-- between the cursor and the next covering entry would otherwise be
-- re-read every tick forever by a stateless Worker (livelock), and a day
-- that resolved out of order would need per-day RPC probing on every tick.

-- Per-(chain, day, side) scan frontier: the entry id from which the next
-- scan should resume — every id below it has been read and is either
-- submitted on-chain or verified non-covering (day coverage is immutable
-- once the day's funding stamp + local close are in, which is when the
-- pass runs). last_cursor detects an operator resetCommitmentAccumulation
-- (the on-chain cursor moved BACKWARD), which invalidates the frontier so
-- the full range is rescanned and previously-submitted entries are
-- resubmitted.
CREATE TABLE IF NOT EXISTS keeper_commitment_scan (
  chain_id INTEGER NOT NULL,
  day_id INTEGER NOT NULL,
  side INTEGER NOT NULL,
  scan_next TEXT NOT NULL,     -- bigint as string
  last_cursor TEXT NOT NULL,   -- bigint as string
  updated_at INTEGER NOT NULL, -- unix seconds
  PRIMARY KEY (chain_id, day_id, side)
);

-- Per-(chain, day) resolution marker: stamped once the day's report is
-- complete AND dispatched. Later ticks skip marked days with zero RPC
-- reads — the pass scans its full bounded day range every tick (days can
-- resolve out of order, so "first resolved day" is not a stopping proof),
-- and without this marker the steady-state RPC cost would grow with
-- history.
CREATE TABLE IF NOT EXISTS keeper_commitment_day (
  chain_id INTEGER NOT NULL,
  day_id INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL, -- unix seconds
  PRIMARY KEY (chain_id, day_id)
);
