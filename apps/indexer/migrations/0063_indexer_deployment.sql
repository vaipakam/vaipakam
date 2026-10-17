-- #1566 / Codex #2545 r1–r3 — the Diamond a chain's rows were indexed FROM.
--
-- WHY. Offers and loans are keyed by (chain_id, numeric id) and the scan
-- cursor by (chain_id, kind): nothing in the database named the Diamond the
-- rows came from. A fresh redeploy (a new Diamond at a new deploy block on the
-- same chain) therefore did not begin a new epoch for a running indexer — the
-- cursor kept advancing past the new deploy block until the new bundle rolled
-- out, then skipped that interval forever; the retired Diamond's rows stayed
-- and their ids collided with the ids the fresh Diamond restarts at. The
-- deploy script's row purge was the only enforcement, and it ran OUTSIDE the
-- indexer, against a schema it introspected by hand.
--
-- WHAT. One row per chain: the Diamond and deploy block the indexer has
-- ADOPTED. `src/deploymentEpoch.ts` compares the bundle's Diamond with this row
-- at the top of every pass; a different, newer Diamond is a new epoch and the
-- pass resets the chain's chain-scoped rows (every table carrying `chain_id`,
-- minus the user-owned ones `src/diamondEpochKeep.json` names) before it
-- scans, so the cursor reseeds from the new deploy block. `reset_pending` is
-- set BEFORE the reset and cleared IN the same batch as the deletes, and every
-- statement of that batch is guarded by the claim, so a pass that dies between
-- the two redoes the reset and a pass whose claim was overtaken deletes nothing.
--
-- `adopted_blind` marks a row written by a FIRST adoption (no prior record):
-- nothing was reset, because nothing said which Diamond the existing rows came
-- from. A deploy that retires a Diamond SEEDS it (scripts/lib/
-- retiredDeploymentSeed.mjs, run by the indexer's deploy between migration
-- apply and publish); the seed may replace a blind row, never a row whose
-- epoch was earned by a reset, and the indexer's next pass does the rest.
CREATE TABLE IF NOT EXISTS indexer_deployment (
  chain_id      INTEGER PRIMARY KEY,
  diamond       TEXT    NOT NULL,   -- 0x-prefixed, compared case-insensitively
  deploy_block  INTEGER NOT NULL,
  adopted_at    INTEGER NOT NULL,   -- unix seconds
  reset_pending INTEGER NOT NULL DEFAULT 0,
  adopted_blind INTEGER NOT NULL DEFAULT 0
);
