-- #2497 r10 — the keeper's own DEPLOYMENT EPOCH per chain, keeper-private.
--
-- The indexer resets its chain-scoped tables when a chain's Diamond changes
-- (apps/indexer/src/deploymentEpoch.ts): loan ids, remit ids and day records
-- restart on a fresh Diamond, so a row left from the old one would be read
-- against the new one's ids. That reset cannot reach this database. So the
-- keeper applies the same rule to its own state: each tick compares every
-- chain's Diamond with the one recorded here, and on a change clears that
-- chain's rows from every private table keyed by chain but NOT by Diamond
-- (today hf_band_state and the keeper_commitment_* pair; tables that carry
-- a `diamond` column are already namespaced and need nothing), VERIFIES each
-- of those tables reads empty for the chain, and only then records the new
-- Diamond. Not a batch: the machine reaches D1 over HTTP, whose batch atomicity
-- is not established (KeeperMachine.md). Each step is idempotent and the
-- record moves last, so a reset cut off anywhere is redone whole next tick.
-- It also waits for the indexer to adopt the same Diamond first (#2497 r12).
--
-- Disposable: an empty table adopts the Diamond the indexer has adopted for
-- the chain (what the shared rows the cutover copied belong to), so a fresh
-- environment, and the first tick after the cutover, reset nothing.
CREATE TABLE IF NOT EXISTS keeper_deployment (
  chain_id   INTEGER PRIMARY KEY,
  diamond    TEXT    NOT NULL,   -- lowercased
  adopted_at INTEGER NOT NULL    -- unix seconds
);
