-- #3734 — the on-chain Terms of Service record, as the indexer reads it, so
-- the book can mark a commitment its maker cannot fill now and a wallet can
-- be told where it stands. Design: docs/DesignsAndPlans/
-- TermsAcceptanceEnforcementDesign.md, sections 3, 5, 7 ("The book") and 8.
--
-- Both tables are replay-derived and chain-scoped: rebuilt from the
-- Diamond's own events, reset with the chain's other rows on a new Diamond
-- (a fresh deploy starts a fresh record) and never shared across networks
-- (an acceptance belongs to one wallet on one network). The platform keeps
-- no other record of acceptances: there is no signature store.
--
-- 1. `terms_change` — every publication, announcement, withdrawal and
--    coming-into-force on one network, in log order. The versions in force,
--    the minimum and the latest are FOLDED from this log at read time
--    (`src/termsStanding.ts`), because an announcement comes into force at
--    a time, not at an event: the fold applies it once `in_force_at` has
--    passed, whether or not a coming-into-force event has been read yet.
--      kind          'published'  a version in force at once (the first
--                                 version on a network, or a small change);
--                    'announced'  a material change: the minimum moves to
--                                 `version` at `in_force_at`;
--                    'withdrawn'  the open announcement is dropped;
--                    'in-force'   the announced change came into force.
--      moves_minimum 1 when the event moves the minimum (the event says so).
--      in_force_at   unix seconds the change comes into force; for a
--                    publication, the block time.
CREATE TABLE IF NOT EXISTS terms_change (
  chain_id      INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  log_index     INTEGER NOT NULL,
  tx_hash       TEXT    NOT NULL,
  kind          TEXT    NOT NULL
                CHECK (kind IN ('published', 'announced', 'withdrawn', 'in-force')),
  version       INTEGER NOT NULL,
  terms_hash    TEXT,                       -- the fingerprint, 0x-64-hex
  moves_minimum INTEGER NOT NULL DEFAULT 0,
  in_force_at   INTEGER,
  block_at      INTEGER NOT NULL,           -- the event's block time
  PRIMARY KEY (chain_id, block_number, log_index)
);

-- 2. `terms_acceptance` — one row per (network, wallet, version) a wallet
--    accepted by its own transaction: the version, the fingerprint it
--    named, when, and the transaction. A repeated acceptance of the same
--    version keeps the first record.
CREATE TABLE IF NOT EXISTS terms_acceptance (
  chain_id     INTEGER NOT NULL,
  wallet       TEXT    NOT NULL,            -- lowercase 0x-40-hex
  version      INTEGER NOT NULL,
  terms_hash   TEXT,                        -- the fingerprint, 0x-64-hex
  accepted_at  INTEGER NOT NULL,            -- the event's time
  block_number INTEGER NOT NULL,
  log_index    INTEGER NOT NULL,
  tx_hash      TEXT    NOT NULL,
  PRIMARY KEY (chain_id, wallet, version)
);

-- Additive: two new tables. The code still serving while this lands names
-- neither, and every read of them tolerates their absence.
