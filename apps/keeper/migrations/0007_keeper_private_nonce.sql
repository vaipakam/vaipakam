-- apps/keeper/migrations/0007_keeper_private_nonce.sql
--
-- #3240 — the next nonce the keeper key may use on a chain with a PRIVATE
-- submission route, recorded before each private broadcast. A chain's ordinary
-- RPC cannot see a private transaction until it is mined, so its pending count
-- would hand a restarted keeper (an update, a crash) the nonce of a private
-- liquidation still waiting to land, and the next send would replace it. The
-- submission slot reads this row on every private send and takes the higher
-- of it and the pending count while the row is recent
-- (`PRIVATE_ROUTE_FLOOR_TTL_MS`).
--
-- Keyed by `network_id`, deliberately NOT `chain_id`: a nonce belongs to the
-- account on the network, not to a Diamond, so it must survive a fresh
-- Diamond's epoch reset (`keeperEpoch.ts` clears every table with a
-- `chain_id` column). Additive: a new table the running build never reads.
CREATE TABLE IF NOT EXISTS keeper_private_nonce (
  network_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  next_nonce INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (network_id, address)
);
