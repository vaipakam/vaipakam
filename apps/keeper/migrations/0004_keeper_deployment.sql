-- #2497 r10 — the keeper's own DEPLOYMENT EPOCH per chain, keeper-private.
--
-- The indexer resets its chain-scoped tables when a chain's Diamond changes
-- (apps/indexer/src/deploymentEpoch.ts): loan ids, remit ids and day records
-- restart on a fresh Diamond, so a row left from the old one would be read
-- against the new one's ids. That reset cannot reach this database. So the
-- keeper applies the same rule to its own state: each tick compares every
-- chain's Diamond with the one recorded here and, on a change, resets that
-- chain's rows in the private tables keyed by chain but not by Diamond. WHICH
-- tables, and the verified order — delete, read each back empty, only then
-- record the new Diamond, never a batch — are src/keeperEpoch.ts's, written
-- once there; this header does not repeat the list, which drifted when it did.
--
-- Disposable: an empty table adopts the Diamond the indexer has adopted for
-- the chain (what the shared rows the cutover copied belong to), so a fresh
-- environment, and the first tick after the cutover, reset nothing.
CREATE TABLE IF NOT EXISTS keeper_deployment (
  chain_id   INTEGER PRIMARY KEY,
  diamond    TEXT    NOT NULL,   -- lowercased
  adopted_at INTEGER NOT NULL    -- unix seconds
);
