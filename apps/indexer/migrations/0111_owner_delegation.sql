-- #3434 part 2 — the agent's EIP-7702 delegation watch.
--
-- One row per (chain, owner wallet) the agent watches: what the wallet's code
-- said at the last check — '' for no code, the lowercased delegate of a 7702
-- delegation designator, or 'contract' for other code — and when it was
-- checked. A change between two checks is what the owner is told about.
--
-- The wallet's, not the Diamond's: kept across a fresh Diamond
-- (diamondEpochKeep.json). Additive: a new table.
CREATE TABLE IF NOT EXISTS owner_delegation (
  chain_id    INTEGER NOT NULL,
  wallet      TEXT NOT NULL,
  delegation  TEXT NOT NULL,
  checked_at  INTEGER NOT NULL,
  PRIMARY KEY (chain_id, wallet)
);
