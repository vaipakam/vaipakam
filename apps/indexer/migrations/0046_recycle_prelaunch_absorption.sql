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
-- NO "is day 0 conflated?" FLAG LIVES HERE, and the reason is worth stating
-- because the obvious implementations are all unsound.
--
-- On a Diamond upgraded in place, credits taken before the upgrade are
-- already inside `recycledCreditedByDay[0]` and nothing can separate them.
-- The tempting inference — "a chain that has emitted a pre-launch event has
-- the split, so anything after that is clean" — has a false positive on the
-- ordinary case: a fresh deployment that simply takes NO credits before
-- launch never emits one, so its first genuine day-0 credit would be marked
-- legacy forever (Codex #1508 r3 P2). The absence of an optional event
-- proves nothing about which contract version is deployed.
--
-- Which version is deployed is DEPLOYMENT PROVENANCE, not something the
-- event stream carries. Rather than guess in either direction — and a wrong
-- flag is worse than none on a transparency surface — this table records
-- only what is observed, and the endpoint documents the limit.
CREATE TABLE IF NOT EXISTS recycle_prelaunch (
  chain_id INTEGER NOT NULL PRIMARY KEY,
  absorbed TEXT NOT NULL DEFAULT '0'
);

-- Per-source LIFETIME recycled cumulative, as each chain reports it.
--
-- The runway numerator is "cumulative recycled" — a lifetime stock. On the
-- canonical chain the day series only carries what was ATTRIBUTED to days,
-- and two kinds of real recycled value sit outside it:
--
--   * a mirror's PRE-LAUNCH stock, which belongs to no day and is never in
--     any day report;
--   * value clamped away at attribution time (`accepted` is bounded by the
--     reporting chain's remaining headroom), which is still absorbed value
--     in that chain's bucket.
--
-- Both are inside the `cumulative` a chain reports, which is its own
-- `recycleCreditedCumulative` and counts every credit it ever took. So the
-- numerator uses that figure per mirror instead of the sum of accepted day
-- credits — otherwise adding only the canonical chain's own pre-launch stock
-- fixes the single-chain case and still understates a mesh (Codex #1508 r4).
--
-- Monotonic by construction on-chain, and stored as a MAX so an out-of-order
-- or replayed report can never walk it backwards.
--
-- REPLAY-DERIVED: a fold of chain logs, rebuilt from block zero on restore.
CREATE TABLE IF NOT EXISTS recycle_chain_reported (
  chain_id INTEGER NOT NULL,
  source_chain_id INTEGER NOT NULL,
  reported_cumulative TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (chain_id, source_chain_id)
);
