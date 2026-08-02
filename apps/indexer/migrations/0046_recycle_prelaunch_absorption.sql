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
CREATE TABLE IF NOT EXISTS recycle_prelaunch (
  chain_id INTEGER NOT NULL PRIMARY KEY,
  absorbed TEXT NOT NULL DEFAULT '0'
);
