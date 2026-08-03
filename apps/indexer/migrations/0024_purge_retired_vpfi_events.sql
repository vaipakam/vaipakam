-- #717 — purge retired VPFI event rows from the activity feed.
--
-- The `StakingRewardsClaimed` (5% APR staking yield, removed in #687-B) and
-- `VPFIPurchasedWithETH` (fixed-rate VPFI sale, removed in #687-A) events no
-- longer exist in the diamond ABI. The indexer's `EVENT_ABI` is derived from
-- the compiled ABI, so it stops decoding/writing them going forward; and the
-- front-end (logIndex union + Activity/LoanTimeline label/accent maps) dropped
-- both kinds. But any row the indexer wrote BEFORE the excision lingers in the
-- shared `vaipakam-archive` D1, and the Worker `/activity` feed
-- (`useIndexedActivity`) would keep serving those rows — which now render with
-- a blank label / `status-undefined` because the front-end no longer maps them.
--
-- Purge them so the Worker-backed feed matches the browser fallback feed (whose
-- cache key was bumped v4→v5 in the same change). Idempotent: re-running is a
-- no-op once the rows are gone.
DELETE FROM activity_events
 WHERE kind IN ('StakingRewardsClaimed', 'VPFIPurchasedWithETH');
