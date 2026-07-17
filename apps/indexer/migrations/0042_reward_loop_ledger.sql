-- 0042 — RL-2 (#1303) reward loop-closure ledger
-- (docs/DesignsAndPlans/VpfiRecyclingLoopClosureDesign.md §6 RL-2).
--
-- Tracks how much of the distributed interaction-reward VPFI stays inside
-- the sink system. Driven by three Diamond events:
--   InteractionRewardsClaimed  → distributed[user][day]
--   RewardDeliveredToVault     → vault_delivered[user][day] + retention credit
--   VaultVpfiDebited           → reward_funded_debits[user][day] + retention
--                                decrement (min-clamped: debits spend
--                                reward-delivered VPFI FIRST; non-reward
--                                deposits never re-inflate the ledger)
--
-- Amounts are 18-dec wei stored as DECIMAL STRINGS (TEXT): wei overflows
-- SQLite's int64 (the same reason rateCandles folds BigInt in JS). All
-- arithmetic happens in JS BigInt inside the single-writer ChainIngestDO,
-- so read-modify-write is race-free by the runtime's alarm() serialization.
--
-- day_id is the UTC epoch-day of the BLOCK the event landed in — the
-- claim-day basis RL-2 pins for BOTH sides of the ratio (the day tokens
-- leave protocol custody). Underlying finalized reward days are never
-- re-split.

-- Exactly-once dedup + audit trail. The ingest can re-scan overlapping
-- ranges (webhook + sweep), so ledger effects apply ONLY when the event
-- row inserts fresh; the whole per-event effect set runs in one D1 batch
-- (a transaction) so a crash can't split "recorded" from "applied".
-- retained_delta records the signed retention effect for rebuilds.
CREATE TABLE IF NOT EXISTS reward_loop_events (
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  user TEXT NOT NULL,
  amount TEXT NOT NULL,
  day_id INTEGER NOT NULL,
  retained_delta TEXT NOT NULL,
  block_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS idx_reward_loop_events_day
  ON reward_loop_events (chain_id, day_id);

-- Per-user retention ledger: reward-delivered VPFI still sitting in the
-- user's vault (conservative lower bound — can never overstate closure).
CREATE TABLE IF NOT EXISTS reward_retention (
  chain_id INTEGER NOT NULL,
  user TEXT NOT NULL,
  retained TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (chain_id, user)
);

-- Per-(user, day) flow components. Netting is PER USER then summed
-- (RL-2: an aggregate net would let user B spending old rewards cancel
-- user A's same-day retained delivery on mixed-user days):
--   netVaultDelivered[D] = Σ_u max(0, vault_delivered − reward_funded_debits)
CREATE TABLE IF NOT EXISTS reward_day_user (
  chain_id INTEGER NOT NULL,
  day_id INTEGER NOT NULL,
  user TEXT NOT NULL,
  distributed TEXT NOT NULL DEFAULT '0',
  vault_delivered TEXT NOT NULL DEFAULT '0',
  reward_funded_debits TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (chain_id, day_id, user)
);

CREATE INDEX IF NOT EXISTS idx_reward_day_user_day
  ON reward_day_user (chain_id, day_id);

-- O(1) cumulative counters for the stock ratio:
--   cumLoopClosureRatio = (retained_stock + cum_absorbed) / cum_distributed
-- cum_absorbed stays '0' until the governor stack's VpfiRecycled events
-- exist (PR-3a extension point — see rewardLoopLedger.ts).
CREATE TABLE IF NOT EXISTS reward_loop_totals (
  chain_id INTEGER PRIMARY KEY,
  cum_distributed TEXT NOT NULL DEFAULT '0',
  cum_absorbed TEXT NOT NULL DEFAULT '0',
  retained_stock TEXT NOT NULL DEFAULT '0'
);
