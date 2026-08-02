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
