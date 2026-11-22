-- #3433 — what the off-chain checker found about each asset's issuer powers.
--
-- A vault can lose an asset, or be unable to move it, without any protocol
-- call: a token whose issuer can claw it back, force a transfer, freeze or
-- pause it, or upgrade its code; a collection whose transfer validator can
-- block the platform's conduit, or whose tokens cannot be transferred at
-- all. The contracts stay uncurated (owner decision 2026-11-15), so this is
-- found off-chain and disclosed in the apps. The keeper machine runs the
-- checks and writes these two tables; the indexer serves them read-only on
-- `GET /assets/issuer-powers?chainId=`, beside the market-cap rankings
-- (0087). No user data.
--
-- What is stored is WHAT WAS CHECKED and WHAT IT FOUND, never a verdict:
-- a check that could not run is stored as 'unknown', and an asset with no
-- row has not been checked. Nothing here may be read as "safe".
--
-- asset_issuer_check: one row per (token chain, contract address), the
-- latest check run for that asset. `kind` is what the checker took the
-- contract to be. `complete` = 1 when every check in the checker's list
-- ran (each finding is 'found' or 'not_found'); 0 when any is 'unknown'
-- or the run stopped part-way (`detail` says why). `checker_version`
-- names the list of checks the run applied, so a reader can tell an older
-- run that never looked for a newer power.
--
-- asset_issuer_finding: one row per check per asset, written in the SAME
-- batch as its asset row with the same checked_at, replacing the asset's
-- previous findings, so a reader never sees two runs mixed.
--   check_id — the check's stable id (the list lives in
--     packages/lib/src/issuerPowers.ts; new checks need no migration).
--   result   — 'found' (the power exists), 'not_found' (looked, absent),
--     'unknown' (could not tell).
--   evidence — a short public fact behind the result (a function selector,
--     the proxy's admin or implementation slot, the validator address).
--
-- chain_id is the TOKEN's chain, not a Diamond's; both tables are listed in
-- src/diamondEpochKeep.json so a fresh Diamond does not wipe them.
--
-- Additive: two new tables, safe while the previous Workers are serving
-- (nothing reads or writes them yet).
CREATE TABLE IF NOT EXISTS asset_issuer_check (
  chain_id        INTEGER NOT NULL,
  address         TEXT    NOT NULL CHECK (address = lower(address) AND length(address) = 42),
  kind            TEXT    NOT NULL CHECK (kind IN ('erc20', 'erc721', 'erc1155', 'unknown')),
  checked_at      INTEGER NOT NULL,
  block_number    INTEGER NOT NULL,
  checker_version TEXT    NOT NULL CHECK (length(checker_version) BETWEEN 1 AND 32),
  complete        INTEGER NOT NULL CHECK (complete IN (0, 1)),
  detail          TEXT    CHECK (detail IS NULL OR length(detail) <= 300),
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS asset_issuer_finding (
  chain_id   INTEGER NOT NULL,
  address    TEXT    NOT NULL CHECK (address = lower(address) AND length(address) = 42),
  check_id   TEXT    NOT NULL CHECK (length(check_id) BETWEEN 1 AND 40),
  result     TEXT    NOT NULL CHECK (result IN ('found', 'not_found', 'unknown')),
  evidence   TEXT    CHECK (evidence IS NULL OR length(evidence) <= 300),
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, address, check_id)
);
