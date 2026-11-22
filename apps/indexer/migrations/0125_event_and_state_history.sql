-- #3921 — the indexer's event history and the state at a block
-- (TroubleshootingPictureDesign.md §4.5, §4.6).
--
-- Three replay-derived histories (and where they begin), each written by the scan in the same pass
-- as the block it came from, and each cleared and rebuilt with the chain's
-- other rows on a reorg rebuild or a new Diamond (deploymentEpoch.ts finds
-- them by their chain_id column).

-- EVERY log the platform's contracts emit on the network: the Diamond, the
-- position token and each standalone contract in the deployment record
-- (not the testnet's mock assets). Decoded with the platform's ABIs where one
-- describes it, kept raw (topics and data) where none does, so an event no
-- handler reads, or one this build cannot decode, is still on record.
-- `activity_events` stays the users' feed; this table is the full record.
CREATE TABLE IF NOT EXISTS chain_event_log (
  chain_id      INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  log_index     INTEGER NOT NULL,
  -- The transaction's place in the block, so "what was true for this
  -- transaction" can be asked of a transaction with no logs of its own.
  tx_index      INTEGER NOT NULL,
  tx_hash       TEXT    NOT NULL,
  address       TEXT    NOT NULL,
  topic0        TEXT,
  -- Null when no ABI in this build describes the log.
  event_name    TEXT,
  args_json     TEXT,
  -- {"topics":[...],"data":"0x..."} when undecoded; null when decoded.
  raw_json      TEXT,
  block_at      INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS idx_chain_event_log_tx ON chain_event_log(chain_id, tx_hash);
CREATE INDEX IF NOT EXISTS idx_chain_event_log_name ON chain_event_log(chain_id, event_name, block_number);
CREATE INDEX IF NOT EXISTS idx_chain_event_log_address ON chain_event_log(chain_id, address, block_number);

-- One row per change of the protocol's settings, with the event, the values
-- it carries (`event_args_json`) and the transaction that caused it. A
-- reader applies the events' own values in order, which is exact between two
-- changes in one block. `values_json` adds the full settings as read at the
-- END of the block (`values_basis` 'end-of-block'), for what no event
-- carries. When a block holds more than one change, every row but the
-- block's last is marked `unknown_between`: its read is the block's last
-- values, not the ones in force between it and the next change. 'pending'
-- until the read is made, 'unreadable' when the node cannot answer for that
-- block (`read_error`); the event's own values stand either way.
CREATE TABLE IF NOT EXISTS settings_history (
  chain_id        INTEGER NOT NULL,
  block_number    INTEGER NOT NULL,
  tx_index        INTEGER NOT NULL,
  log_index       INTEGER NOT NULL,
  tx_hash         TEXT    NOT NULL,
  event_name      TEXT    NOT NULL,
  event_args_json TEXT    NOT NULL,
  values_basis    TEXT    NOT NULL DEFAULT 'pending',
  values_json     TEXT,
  unknown_between INTEGER NOT NULL DEFAULT 0,
  read_attempts   INTEGER NOT NULL DEFAULT 0,
  read_error      TEXT,
  block_at        INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);
CREATE INDEX IF NOT EXISTS idx_settings_history_pending ON settings_history(chain_id, values_basis, block_number);

-- Every change to the Diamond's routing, from its DiamondCut event: which
-- code serves which function from which point. One row per function in the
-- cut; `facet` is null for a removal.
CREATE TABLE IF NOT EXISTS facet_history (
  chain_id      INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  tx_index      INTEGER NOT NULL,
  log_index     INTEGER NOT NULL,
  tx_hash       TEXT    NOT NULL,
  selector      TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  facet         TEXT,
  block_at      INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index, selector)
);
CREATE INDEX IF NOT EXISTS idx_facet_history_selector ON facet_history(chain_id, selector, block_number, tx_index, log_index);

-- The first block the histories above cover on a network. An indexer that
-- took them on mid-chain has no history below it, and a reader is told so
-- rather than shown an empty past as a quiet one.
CREATE TABLE IF NOT EXISTS history_coverage (
  chain_id    INTEGER PRIMARY KEY,
  from_block  INTEGER NOT NULL
);
