-- apps/keeper/migrations/0009_keeper_runner_lease.sql
--
-- #1722 — the one-runner lease (#2503), moved into the keeper's PRIVATE
-- database.
--
-- Every tick, on the Worker or a machine, first claims this row
-- (apps/keeper/src/runnerLease.ts) and runs nothing while another runner
-- holds it. It began in the shared database (indexer migration 0059), where
-- every Worker bound to that database can write any table: the indexer or
-- the agent could hold the lease with a far-off expiry and stop every keeper
-- pass, liquidations included. Here only the keeper can write it.
--
-- One row, `lease = 'keeper'`. A claim succeeds when the row is absent, when
-- the claimant already holds it (a renewal), when it has expired, or when its
-- expiry lies further out than any claim the keeper writes. The times are the
-- database's clock in milliseconds.
--
-- No chain_id column, so a fresh Diamond's epoch reset (`keeperEpoch.ts`)
-- leaves it alone: the lease belongs to the runner, not to a Diamond.
-- Additive: a new table the running build never reads. The shared copy is
-- dropped by a later shared migration once every runner claims here.
CREATE TABLE IF NOT EXISTS keeper_runner_lease (
  lease       TEXT    PRIMARY KEY,
  holder      TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  renewed_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
