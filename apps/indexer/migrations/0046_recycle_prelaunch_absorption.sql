-- 0046 — #1504: pre-launch absorption, held apart from the day series.
--
-- Absorption credited while the emission schedule is INACTIVE belongs to no
-- programme day, so the contracts stopped filing it under day 0 and now
-- announce it through its own event. This table is where the recycling
-- transparency series keeps that quantity: a single per-chain total, NOT a
-- day bucket, because there is no day to key it on.
--
-- Published beside the day series rather than dropped: the value backs the
-- recycle bucket and is inside every cumulative, so it is exactly what
-- explains the difference between the bucket and the sum of the days.
--
-- REPLAY-DERIVED (docs/ops/OffChainRestore.md §6): a fold of chain logs and
-- nothing else, so the restore clears it and rebuilds it from block zero.
--
-- `split_seen` / `day0_legacy` exist to answer ONE question honestly: can
-- this chain's day 0 still contain pre-launch value?
--
-- On a fresh deployment, no: the contracts file pre-launch credits
-- separately from the start. On a Diamond UPGRADED IN PLACE — which is the
-- deployed testnets — credits taken before the upgrade are already inside
-- `recycledCreditedByDay[0]` and no code change can separate them.
--
-- The indexer can tell the two apart by ORDER, the same way RL-2 dates its
-- debit-observability boundary: once a chain has emitted its first
-- `VpfiRecycledPreLaunch`, its contracts carry the split, so any later
-- day-0 credit is a genuine first-scheduled-day credit. Day-0 credits seen
-- BEFORE that point are ambiguous, and `day0_legacy` counts them. A blanket
-- "day 0 is clean now" would be false on exactly the deployments this work
-- is being exercised on (Codex #1508 r2 P2).
CREATE TABLE IF NOT EXISTS recycle_prelaunch (
  chain_id INTEGER NOT NULL PRIMARY KEY,
  absorbed TEXT NOT NULL DEFAULT '0',
  split_seen INTEGER NOT NULL DEFAULT 0,
  day0_legacy TEXT NOT NULL DEFAULT '0'
);
