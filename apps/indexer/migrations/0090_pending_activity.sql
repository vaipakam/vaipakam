-- #3411 part 2 — the PENDING lane: events above the chain's "safe" block, shown
-- at once and marked as not final yet.
--
-- The scan writes `activity_events` only up to the chain's own "safe" block,
-- so a reorganisation cannot leave a row behind. That makes a fresh action
-- wait several minutes to appear. This lane closes the gap without weakening
-- the rule: each pass that has caught up to the safe block also reads the
-- blocks above it, up to the chain's latest block, and REPLACES this chain's
-- rows here with what it found. Nothing here is ever promoted by hand. Once
-- the safe block passes an event, the scan writes it to `activity_events` and
-- the next replacement leaves it out. An event a reorganisation removed is
-- simply absent from the next replacement.
--
-- `pending_activity_window` records what the last read covered, so a reader
-- can say how current the lane is and whether it is complete, instead of
-- implying either. Both tables are chain-scoped (they carry `chain_id`), so a
-- deployment epoch reset or a reorg rebuild clears them with the rest.
--
-- Additive: two new tables, safe while the previous Workers are still serving
-- (they never read them).
CREATE TABLE IF NOT EXISTS pending_activity_events (
  chain_id     INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  -- The hash of the block the event was read in. Kept so a reader can tell
  -- the event apart from one at the same position in a replacement block.
  block_hash   TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  loan_id      INTEGER,
  offer_id     INTEGER,
  actor        TEXT,
  args_json    TEXT    NOT NULL,
  -- The normalized value, as in activity_events (0055). NULL = not
  -- established, which is common here: a loan or offer created in a block
  -- that is not final yet has no row to read it from.
  asset        TEXT,
  asset_type   INTEGER,
  amount       TEXT,
  amount_max   TEXT,
  token_id     TEXT,
  quantity     TEXT,
  PRIMARY KEY (chain_id, block_number, log_index)
);

CREATE TABLE IF NOT EXISTS pending_activity_window (
  chain_id      INTEGER NOT NULL PRIMARY KEY,
  -- Events at or below this block are final and served by /activity itself.
  final_through INTEGER NOT NULL,
  -- The last block the read covered, and the chain's latest block at the read.
  through_block INTEGER NOT NULL,
  latest_block  INTEGER NOT NULL,
  -- 1 when the read stopped short of `latest_block` or kept only the first
  -- rows it found: the lane is then a true but incomplete list.
  truncated     INTEGER NOT NULL,
  -- Which events the rows are (block, position and block hash), so a pass can
  -- tell whether the lane changed and announce it.
  fingerprint   TEXT    NOT NULL,
  read_at       INTEGER NOT NULL
);
