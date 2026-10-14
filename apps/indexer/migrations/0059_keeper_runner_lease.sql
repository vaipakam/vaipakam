-- #2503 — one keeper runner at a time.
--
-- The keeper can run on a Cloudflare Worker or on an always-on machine
-- (apps/keeper/host), and every copy signs with the same key. Two copies
-- running at once would race each other's sends and per-tick state, so each
-- tick first claims this lease (apps/keeper/src/runnerLease.ts) and declines,
-- by name, while another runner holds it.
--
-- One row, `lease = 'keeper'`. A claim succeeds when the row is absent, when
-- the claimant already holds it (a renewal), or when it has expired. A
-- runner that stops renewing loses the lease after its TTL, so a dead machine
-- hands over by itself; a live one renews every minute.
--
-- Keeper-only state, here because the shared database is the only one the
-- machine runner can reach today. It moves to the keeper's private database
-- with the other keeper-only tables when #2497 lands, by the same cutover.
--
-- Additive: no existing table changes, so the deployed Workers are unaffected
-- until a keeper build that claims the lease ships.
CREATE TABLE IF NOT EXISTS keeper_runner_lease (
  lease       TEXT    PRIMARY KEY,
  holder      TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  renewed_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
