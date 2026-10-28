-- #2337 — the off-chain check on every loan-status change.
--
-- The platform allows a loan's status to move only along a fixed diagram, and
-- the contracts reject any other move. An observer outside the contracts must
-- still be able to say so independently: a status change the diagram does
-- not allow, seen on chain, means a contract defect or an indexer that has
-- drifted from the contracts, and either needs an operator at once. The
-- reference subgraph that used to count these is retired with this change;
-- the indexer now records them and states the count on GET /health/ingest,
-- where the scheduled ingest probe pages on it (src/loanLifecycleGuard.ts).
--
-- loan_lifecycle_state — the status this indexer last saw announced for each
--   loan, and the log position that announced it.
--     status           — the contract's status number (0 Active … 5
--                        InternalMatched), exactly as the event carried it.
--     from_initiation  — 1 when this indexer saw the loan's initiation, so
--                        every later announcement can be checked against the
--                        one before it; 0 for a loan first seen part-way
--                        through its life, whose first announcement can only
--                        be checked against the diagram.
--     last_block,
--     last_log_index   — the position of the announcement that set `status`.
--                        A log at or before it has already been applied, so a
--                        replayed scan neither re-applies nor re-judges it.
--
-- loan_lifecycle_violation — one row per announcement the check refused.
--     reasons          — comma-separated: `edge` (the move is not in the
--                        diagram), `continuity` (the move does not start
--                        from the status last seen), `reinitiated` (an
--                        initiation for a loan already being tracked).
--     expected_status  — the status last seen, or NULL when there was none.
--     block_time       — the chain time of the block that carried it.
--     The key is the log itself, so a replayed scan records nothing twice.
--
-- Both tables are rebuilt by a replay of the chain from the deploy block
-- (replay-derived, docs/ops/OffChainRestore.md), and both carry chain_id, so
-- a Diamond change resets them with the rest of the chain's rows.
--
-- Additive: two new tables the deployed indexer neither reads nor writes.
-- Until the indexer that writes them ships, they stay empty.
CREATE TABLE IF NOT EXISTS loan_lifecycle_state (
  chain_id INTEGER NOT NULL,
  loan_id INTEGER NOT NULL,
  status INTEGER NOT NULL,
  from_initiation INTEGER NOT NULL,
  last_block INTEGER NOT NULL,
  last_log_index INTEGER NOT NULL,
  PRIMARY KEY (chain_id, loan_id)
);

CREATE TABLE IF NOT EXISTS loan_lifecycle_violation (
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  loan_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  event TEXT NOT NULL,
  from_status INTEGER,
  to_status INTEGER,
  expected_status INTEGER,
  reasons TEXT NOT NULL,
  block_time INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_loan_lifecycle_violation_order
  ON loan_lifecycle_violation(chain_id, block_number, log_index);
