-- RPC read-diet PR B (Alpha02RpcReadDietDesign §4.2.1) — the protocol-
-- config snapshot the public GET /config/:chainId route serves, so
-- DISPLAY surfaces stop re-reading governance-tunable config from the
-- chain per browser. One row per chain; the indexer refreshes it when
-- a scan sees a config-change event (ConfigFacet/AdminFacet setter
-- events) and on a slow time backstop. Pre-sign paths keep reading the
-- Diamond — this table is display-only by contract.
CREATE TABLE IF NOT EXISTS protocol_config (
  chain_id INTEGER PRIMARY KEY,
  -- getProtocolConfigBundle tuple, JSON array with every numeric slot
  -- serialized as a decimal STRING (bigint-safe round-trip).
  bundle_json TEXT NOT NULL,
  -- getMasterFlags [rangeAmount, rangeRate, partialFill] as JSON bools.
  master_flags_json TEXT NOT NULL,
  -- Block the reads were pinned to, and the write's unix seconds —
  -- clients gate on freshness before trusting the snapshot.
  source_block INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
