-- #3918 — the failed transaction record (TroubleshootingPictureDesign.md §4.3).
--
-- Every failed transaction sent to a contract in a network's deployment
-- record, stored with its error decoded at the time, while the node still had
-- the state. Written ONLY through `POST /internal/failed-tx`
-- (src/failedTx.ts), under the pass's own token: the pass (a small Worker of
-- its own, with no database binding) can add records and mark them, and can
-- touch no other table. Nothing here is replayed from the chain, so a fresh
-- Diamond keeps these rows (each names the Diamond it belongs to, see
-- src/diamondEpochKeep.json), and a block the chain replaced is marked, never
-- deleted.
--
-- failed_tx: one row per (network, transaction, block hash). A transaction
-- re-mined in a replacement block is a second row; the first is marked.
--   found_by        keeper-send | explorer-list | audit | trace-filter |
--                   block-scan: the source that found it
--   mode            trace-filter | list-and-audit | sends-and-audit |
--                   block-scan: the pass's mode for the network then
--   source          trace | rebuilt | replay | none: where the decoding
--                   came from (§4.3's table)
--   explanation     the explainer's output for that source, JSON; null for
--                   `none`. `explanation_cut` = 1 when the longest argument
--                   values were cut to fit the size bound
--   unavailable     JSON list of what the record cannot hold (a replay
--                   lacks the call path, a `none` record the error too)
--   not_reproduced  1 when a replay succeeded where the transaction failed
--   used_all_gas    1 when gas_used reached gas_limit
--   state_unreachable 1 when the node no longer held the block's state
--   replaced_at     unix seconds the block was found replaced; null while
--                   the chain still agrees with the record
--   loan_id/offer_id the ids the called function names, where it names one
--
-- The pass's own state lives beside it: its cursor and mode per network
-- (failed_tx_cursor), and its statements about block ranges
-- (failed_tx_range): checkpoints, gaps, audit windows and replaced ranges.
--
-- Wallet addresses: `sender` is the transaction's sender, as public as the
-- transaction itself. The record is for operators; the public data feed's
-- address rules apply before any of it is shared outside.
-- Kept 400 days: the indexer cron prunes older records and range rows.
-- Additive: new tables and their indexes only.
CREATE TABLE IF NOT EXISTS failed_tx (
  chain_id          INTEGER NOT NULL,
  tx_hash           TEXT    NOT NULL,
  block_hash        TEXT    NOT NULL,
  block_number      INTEGER NOT NULL,
  block_time        INTEGER NOT NULL,
  tx_index          INTEGER,
  diamond           TEXT    NOT NULL,
  sender            TEXT    NOT NULL,
  contract          TEXT    NOT NULL,
  function_selector TEXT,
  function_name     TEXT,
  loan_id           TEXT,
  offer_id          TEXT,
  error_selector    TEXT,
  error_name        TEXT,
  error_values      TEXT,
  found_by          TEXT    NOT NULL,
  mode              TEXT    NOT NULL,
  source            TEXT    NOT NULL,
  explanation       TEXT,
  explanation_cut   INTEGER NOT NULL DEFAULT 0,
  unavailable       TEXT,
  gas_used          TEXT    NOT NULL,
  gas_limit         TEXT    NOT NULL,
  used_all_gas      INTEGER NOT NULL DEFAULT 0,
  not_reproduced    INTEGER NOT NULL DEFAULT 0,
  state_unreachable INTEGER NOT NULL DEFAULT 0,
  replaced_at       INTEGER,
  recorded_at       INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, block_hash)
);

-- Reads: by block (the replacement walk, a time window), by loan or offer
-- (the case file), by error.
CREATE INDEX IF NOT EXISTS idx_failed_tx_block ON failed_tx (chain_id, block_number);
CREATE INDEX IF NOT EXISTS idx_failed_tx_loan ON failed_tx (chain_id, diamond, loan_id) WHERE loan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_failed_tx_offer ON failed_tx (chain_id, diamond, offer_id) WHERE offer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_failed_tx_error ON failed_tx (chain_id, error_selector, block_number);
CREATE INDEX IF NOT EXISTS idx_failed_tx_time ON failed_tx (block_time);

-- The pass's position per network: the highest block it has finished, its
-- mode, and the time of that block (the health route's age).
CREATE TABLE IF NOT EXISTS failed_tx_cursor (
  chain_id          INTEGER PRIMARY KEY,
  mode              TEXT    NOT NULL,
  block_number      INTEGER NOT NULL,
  block_time        INTEGER NOT NULL,
  -- The share of the day in which failures by others are watched, in basis
  -- points, for sends-and-audit mode; null in the other modes.
  watched_share_bps INTEGER,
  updated_at        INTEGER NOT NULL
);

-- The pass's statements about block ranges, one table, by `kind`:
--   checkpoint  a scanned range's top block (from_block = to_block) and that
--               block's hash. A replaced-range statement marks it
--               (replaced_at) instead of deleting it; the newest unmarked
--               checkpoint is the one the pass checks next. A rescanned
--               height takes the new hash and is live again.
--   gap         a range the pass could not scan, with its reason
--   audit       one sampled audit window: how many failures a full scan
--               found in it (found) and how many of those the other
--               sources had missed (missed)
--   replaced    a range the chain replaced: how many records it marked
--               (marked), none deleted
CREATE TABLE IF NOT EXISTS failed_tx_range (
  chain_id     INTEGER NOT NULL,
  kind         TEXT    NOT NULL,
  from_block   INTEGER NOT NULL,
  to_block     INTEGER NOT NULL,
  block_hash   TEXT,
  reason       TEXT,
  found        INTEGER,
  missed       INTEGER,
  marked       INTEGER,
  replaced_at  INTEGER,
  recorded_at  INTEGER NOT NULL,
  PRIMARY KEY (chain_id, kind, from_block, to_block)
);
CREATE INDEX IF NOT EXISTS idx_failed_tx_range_recent ON failed_tx_range (chain_id, kind, recorded_at);
CREATE INDEX IF NOT EXISTS idx_failed_tx_range_age ON failed_tx_range (recorded_at);
