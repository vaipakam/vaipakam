-- apps/keeper/migrations/0007_keeper_private_nonce.sql
--
-- #3240 — the nonces the keeper key has broadcast on a chain with a PRIVATE
-- submission route, each recorded before its broadcast. A chain's ordinary
-- RPC cannot see a private transaction until it is mined, so its pending count
-- would hand a restarted keeper (an update, a crash) the nonce of a private
-- liquidation still waiting to land, and the next send would replace it. The
-- submission slot reads these rows on every send once records are armed and
-- skips every nonce whose own row is recent (`PRIVATE_ROUTE_FLOOR_TTL_MS`).
--
-- One row per nonce, each with its own time (Codex #3275 r8): a nonce that
-- never went out ages out on its own clock and is refilled, while a newer send
-- behind it keeps its full window.
--
-- Keyed by `network_id`, deliberately NOT `chain_id`: a nonce belongs to the
-- account on the network, not to a Diamond, so it must survive a fresh
-- Diamond's epoch reset (`keeperEpoch.ts` clears every table with a
-- `chain_id` column). Additive: a new table the running build never reads.
CREATE TABLE IF NOT EXISTS keeper_private_nonce (
  network_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  sent_at_ms INTEGER NOT NULL,
  PRIMARY KEY (network_id, address, nonce)
);
