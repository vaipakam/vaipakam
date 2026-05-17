-- 2026-05-17 — T-075: user-initiated erasure of server-side error
-- records (GDPR Art-17 right-to-erasure for the `diag_errors` table).
--
-- Two schema additions, both additive — no existing column changes,
-- no data rewrite. Safe to apply ahead of the erasure endpoint
-- shipping (the new column simply stays NULL until the capture path
-- starts populating it).
--
--   1. `diag_errors.wallet_hash` — the real per-wallet deletion key.
--
--      The capture path stores a *redacted* wallet (`0x…abcd`) for
--      triage display. That redaction is NOT unique — two distinct
--      wallets sharing the same first-4 / last-4 nibbles collapse to
--      the same string. Deleting by the redacted value would erase
--      unrelated users' records on a collision, so it cannot be the
--      erasure key.
--
--      `wallet_hash` is a server-side keyed hash —
--      `HMAC-SHA256(lowercased_full_wallet, DIAG_WALLET_HMAC_KEY)`,
--      hex-encoded — computed transiently at capture time from the
--      full wallet address the frontend sends, then the full address
--      is discarded (never persisted). It is:
--        - unique per wallet (no collisions),
--        - not reversible without the server secret (a plain
--          SHA-256 of an address is trivially rainbow-tabled over
--          every address that has ever transacted — the keyed HMAC
--          is what makes it privacy-preserving),
--        - stable, so an erasure request can recompute the same
--          hash from a freshly signed wallet and match every row.
--
--      NULL for: rows captured before this migration, and any
--      `not-connected` session (no wallet to key on). Those rows
--      simply aren't erasable by the automated path — support is
--      the fallback, exactly as for any pre-key record.
--
--   2. `diag_legal_holds` — admin-only legal-hold register.
--
--      When a valid retention obligation applies to a wallet's
--      records (court / regulator order, live investigation), an
--      operator inserts a row here keyed by that wallet's
--      `wallet_hash`. The automated erasure path checks this table
--      first and SKIPS deletion for any held wallet-hash.
--
--      `disclosure_allowed` governs the separate signed status
--      endpoint ONLY — never the erasure endpoint itself, which is
--      always uniform. Default 0 (false): the status endpoint stays
--      generic and neither confirms nor denies retention — the
--      gag-order-safe posture. An operator flips it to 1 for a
--      specific wallet-hash ONLY when disclosure is lawful and
--      desired (the common GDPR Art-12(4) "tell the data subject
--      why erasure was refused" case); a gagged hold simply leaves
--      it 0. The flag only ever moves toward MORE disclosure, and
--      only by a deliberate human action, so a gag is always safe.

ALTER TABLE diag_errors ADD COLUMN wallet_hash TEXT;

-- The erasure + status paths both look up rows by exact wallet_hash
-- (`WHERE wallet_hash = ?`). Without this index that predicate is a
-- full table scan on every erasure request.
CREATE INDEX IF NOT EXISTS idx_diag_errors_wallet_hash
  ON diag_errors (wallet_hash);

CREATE TABLE IF NOT EXISTS diag_legal_holds (
  wallet_hash         TEXT PRIMARY KEY,         -- HMAC keyed hash; same
                                                --   value as diag_errors.wallet_hash
  hold_reason         TEXT NOT NULL,            -- operator note: order ref,
                                                --   regulator, case id — internal only
  disclosure_allowed  INTEGER NOT NULL DEFAULT 0, -- 0 = status endpoint stays
                                                --   uniform (default, gag-safe);
                                                --   1 = status endpoint may surface
                                                --   the retained-by-law note
  disclosure_note     TEXT,                     -- optional polished, user-facing
                                                --   sentence shown when
                                                --   disclosure_allowed = 1; a
                                                --   neutral default is used if NULL
  legal_doc_ref       TEXT,                     -- locator for the legal document
                                                --   backing the CURRENT hold (set
                                                --   on `place`): a private-store
                                                --   key / DMS id — NOT a public URL
  legal_doc_sha256    TEXT,                     -- SHA-256 of that document, hex —
                                                --   tamper-evident pin of which
                                                --   exact order authorised the hold
  created_at          INTEGER NOT NULL,         -- unix seconds, server clock
  updated_at          INTEGER NOT NULL          -- unix seconds, server clock
);

-- 2026-05-17 — append-only audit trail for legal-hold actions.
--
-- Every place / lift / set-disclosure action on `diag_legal_holds`
-- writes one row here, recording which protocol-admin wallet took
-- the action and when. This table is INSERT-only by contract — no
-- code path updates or deletes from it (the `diag_errors` retention
-- prune does NOT touch it). It is the defensible record that the
-- protocol acted on a genuine legal order, and whether a gagged
-- hold's disclosure flag was ever flipped.
CREATE TABLE IF NOT EXISTS diag_legal_hold_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              INTEGER NOT NULL,       -- unix seconds, server clock
  action          TEXT NOT NULL,          -- 'place' | 'lift' | 'set-disclosure'
  wallet_hash     TEXT NOT NULL,          -- the held wallet's HMAC keyed hash
  admin_wallet    TEXT NOT NULL,          -- signing protocol-admin's address
  detail          TEXT,                   -- reason / disclosure change, free text
  legal_doc_ref   TEXT,                   -- locator for the legal document that
                                          --   authorised THIS action (the order
                                          --   for a `place`, a release letter for
                                          --   a `lift`, …) — required for `place`
  legal_doc_sha256 TEXT                   -- SHA-256 of that document, hex
);

CREATE INDEX IF NOT EXISTS idx_diag_legal_hold_audit_wallet_hash
  ON diag_legal_hold_audit (wallet_hash);
