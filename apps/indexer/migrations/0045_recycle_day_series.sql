-- 0045 — M5 (#1218 / #1349) recycling transparency day series
-- (docs/DesignsAndPlans/VpfiRecyclingCompletionPlan.md §M5).
--
-- Stores the per-day recycling figures the public transparency surface
-- reads, driven by two Diamond events:
--   GovernorDayPoolStamped  → the day's pool composition, once per
--                             finalized day (schedule floor, recycled
--                             budget, Ā, margin, fresh drawdown, armed)
--   VpfiRecycled            → this chain's own absorption for the day
--   ChainRecycledReported   → absorption accepted FROM OTHER CHAINS
--
-- ─────────────────────────────────────────────────────────────────────
-- TWO DAY AXES COEXIST IN THIS DATABASE. THEY MUST NEVER BE JOINED.
-- ─────────────────────────────────────────────────────────────────────
--
-- `day_id` in THIS migration's tables is the REWARD day: whole days since
-- `interactionLaunchTimestamp`, which is what the contracts key
-- `recycledCreditedByDay` / `dayMirrorRecycledCredit` on and what every
-- event below carries in its own payload.
--
-- `day_id` in RL-2's `reward_loop_*` tables (0042) is the UTC EPOCH day of
-- the block — a deliberate choice recorded there, because RL-2's ratio
-- wants the day tokens left protocol custody on BOTH sides.
--
-- Both choices are right for their own metric and the numbers are not
-- comparable: they have different origins AND different boundaries (reward
-- days roll over at `interactionLaunchTimestamp mod 86400`, not at UTC
-- midnight). A join or a UNION across the two would silently align
-- unrelated buckets. The read surface therefore publishes NO calendar
-- date at all: mapping a reward day to one needs the launch timestamp,
-- and resolving it there would make the endpoint a second authority on
-- where day boundaries fall. Consumers get the protocol's own day index.
--
-- Amounts are 18-dec wei stored as DECIMAL STRINGS (TEXT) — wei overflows
-- SQLite's int64, the same reason 0042 and rateCandles fold BigInt in JS.
-- All arithmetic happens in JS BigInt inside the single-writer
-- ChainIngestDO, so read-modify-write is race-free.

-- Exactly-once dedup + audit trail, same shape as 0042: the ingest
-- re-scans overlapping ranges (webhook + sweep), so series effects apply
-- ONLY when the event row inserts fresh, and the whole per-event effect
-- set runs in one D1 batch so a crash cannot split "recorded" from
-- "applied".
CREATE TABLE IF NOT EXISTS recycle_series_events (
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  day_id INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS idx_recycle_series_events_day
  ON recycle_series_events (chain_id, day_id);

-- One row per (chain, reward day).
--
-- `stamped` mirrors the on-chain `getRecycleDayMetrics` shape: the pool
-- columns are meaningful ONLY when it is 1. A day can accrue absorption
-- long before it is finalized, so an unstamped row with real absorbed
-- figures is an ordinary state, not a gap.
--
-- `armed` records whether the governor was armed for that day. It is NOT
-- decoration: on an unarmed day the pool figures are unreserved estimates
-- (claim pricing reads an uncapped half while the stamp records a capped
-- one), so publishing them as net emission overstates in the flattering
-- direction. Every consumer must honour it.
--
-- EVERY row here is REPLAY-DERIVED: each column is a fold of chain logs
-- and nothing else, so the restore procedure clears this table and
-- replays from block zero to rebuild it byte-identically
-- (docs/ops/OffChainRestore.md §6, classified in
-- apps/indexer/scripts/check-table-classification.mjs).
--
-- That is exactly why the pre-cutover BACKFILL does not live here as a
-- `source` column. Days finalized before the widened event shipped can
-- only be recovered from `getRecycleDayMetrics`, which recomputes from
-- `dayCapThreshold18` — a slot `setBroadcastDayCapThreshold` can
-- overwrite for an already-finalized day on a demoted Diamond. Those
-- rows are therefore NOT reproducible by replay and are born-off-chain
-- in the restore sense: they must be archived and re-imported, never
-- regenerated. A table cannot be half-cleared, and the classification is
-- per-table, so mixing the two classes here would guarantee one of them
-- gets the wrong treatment during an incident. The backfill lands as its
-- own table in its own slice; this one stays purely replayable, and
-- "prefer the event where the two disagree" then falls out of read-time
-- precedence rather than depending on write order.
CREATE TABLE IF NOT EXISTS recycle_day_pool (
  chain_id INTEGER NOT NULL,
  day_id INTEGER NOT NULL,
  stamped INTEGER NOT NULL DEFAULT 0,
  schedule_floor TEXT NOT NULL DEFAULT '0',
  recycled_budget TEXT NOT NULL DEFAULT '0',
  a_bar TEXT NOT NULL DEFAULT '0',
  margin_bps INTEGER NOT NULL DEFAULT 0,
  fresh_drawdown TEXT NOT NULL DEFAULT '0',
  armed INTEGER NOT NULL DEFAULT 0,
  -- Absorption, kept as TWO terms rather than one sum.
  --
  -- `absorbed_local` is this chain's own credits (VpfiRecycled.dayId).
  -- `absorbed_mirror` is credit accepted from OTHER chains only.
  --
  -- The split is load-bearing, not presentational. ChainRecycledReported
  -- fires for EVERY reporting chain INCLUDING the canonical chain's own
  -- report, but the contract folds it into `dayMirrorRecycledCredit` only
  -- when `sourceChainId != block.chainid` — the canonical chain's own
  -- credit deliberately stays in the local series. Summing every accepted
  -- report and adding the local series therefore double-counts the
  -- canonical chain, and it does so in the flattering direction:
  -- overstating exactly the cross-chain absorption the programme exists
  -- to demonstrate. Storing the two terms separately means the filter is
  -- visible at rest and a reader adding them cannot get it wrong.
  absorbed_local TEXT NOT NULL DEFAULT '0',
  absorbed_mirror TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (chain_id, day_id)
);
