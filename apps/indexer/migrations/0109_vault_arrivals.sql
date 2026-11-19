-- #3435 — tokens that arrived in a vault, found from the token contracts'
-- own Transfer logs, so the app can list arrivals under "Unrecognised items".
--
-- Additive: two new tables, nothing existing changes.
--
-- `vault_arrival_scan` is one row per vault that has been asked about: where
-- its scan starts (the vault's creation block), how far it has read, the log
-- range the provider accepted, a short lease so only one scan runs per vault,
-- and when the vault was last asked about (the cron keeps a vault current for
-- 30 days after that). `pruned` is set once the candidate store dropped its
-- oldest rows (see below).
CREATE TABLE IF NOT EXISTS vault_arrival_scan (
  chain_id      INTEGER NOT NULL,
  vault         TEXT    NOT NULL,   -- lowercase
  owner         TEXT    NOT NULL,   -- lowercase
  from_block    INTEGER NOT NULL,
  scanned_to    INTEGER NOT NULL,   -- last block fully read; from_block - 1 before any
  range_size    INTEGER NOT NULL,
  lease_until   INTEGER NOT NULL DEFAULT 0,
  last_asked_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  pruned        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_id, vault)
);

-- The cron's walk: vaults asked about recently, least recently updated first.
CREATE INDEX IF NOT EXISTS idx_vault_arrival_scan_asked
  ON vault_arrival_scan (chain_id, last_asked_at);

-- One row per distinct (asset, kind, token id) that arrived in the vault.
-- Nothing a token contract supplies as text is stored: no name, symbol,
-- metadata, sender or amount. `token_id` is '' for ERC-20.
CREATE TABLE IF NOT EXISTS vault_arrival_candidates (
  chain_id    INTEGER NOT NULL,
  vault       TEXT    NOT NULL,   -- lowercase
  asset       TEXT    NOT NULL,   -- lowercase
  kind        TEXT    NOT NULL,   -- 'erc20' | 'erc721' | 'erc1155'
  token_id    TEXT    NOT NULL,   -- decimal string, '' for ERC-20
  first_block INTEGER NOT NULL,
  last_block  INTEGER NOT NULL,
  PRIMARY KEY (chain_id, vault, asset, kind, token_id)
);

-- Newest first, the order the route pages in.
CREATE INDEX IF NOT EXISTS idx_vault_arrival_candidates_newest
  ON vault_arrival_candidates (chain_id, vault, last_block DESC, asset, kind, token_id);
