-- #3281 / #3422 — the vault beacon's events, per chain.
--
-- Every user vault is a beacon proxy, so its code comes from the chain's
-- VaultBeacon (#3204). A new current version, a revoke, a cancel and every
-- vault's pin, unpin and pin-delay change are announced by the beacon's own
-- events. Until now nothing off chain read them, so an owner learned of a
-- coming code change only by noticing it. The indexer now reads the beacon's
-- logs in the same request as the Diamond's and keeps them here; the vault
-- page and the alerts read them through `GET /vault-beacon/events`.
--
-- One row per beacon log, keyed like activity_events. These are the CHAIN'S
-- statements, stored as decoded, never a derived state: what is pending NOW
-- is read from the beacon itself, and a reader of these rows says which block
-- they run through.
--   kind          — the event name (CurrentVaultVersionProposed, …).
--   vault         — the vault a pin event names (lower-case), else NULL.
--   version_id    — the version id the event is about (decimal text), else NULL.
--   executable_at — when a proposal or a pin request may execute (unix
--                   seconds), else NULL.
--   args_json     — every argument, as decoded (big numbers as decimal text).
--
-- chain_id is a Diamond chain: the beacon is deployed with its Diamond, so
-- the rows are reset with the chain's other rows when a fresh Diamond is
-- adopted. Additive: a new table nothing reads yet.
CREATE TABLE IF NOT EXISTS vault_beacon_events (
  chain_id      INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  log_index     INTEGER NOT NULL,
  tx_hash       TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  vault         TEXT    CHECK (vault IS NULL OR (vault = lower(vault) AND length(vault) = 42)),
  version_id    TEXT,
  executable_at INTEGER,
  args_json     TEXT    NOT NULL,
  block_at      INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE INDEX IF NOT EXISTS idx_vault_beacon_events_vault
  ON vault_beacon_events (chain_id, vault, block_number DESC, log_index DESC);
