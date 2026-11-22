-- #3882 — the table of rental rights (ProjectKitDesign.md §12).
--
-- One row per rental, keyed by network and loan id (the rental loan names
-- the one rental, which is how two concurrent ERC-1155 rentals of one token
-- stay apart). Written only by the indexer from the Diamond's
-- `VaultRentalUpdated` event (src/rentalRights.ts), so the table is
-- replay-derived: a rebuild or a new deployment clears it with the other
-- chain-scoped rows and the replay writes it again.
--
--   collection, token_id  the rented item (token_id is a decimal string)
--   owner                 the event's `lender`: the owner of the vault that
--                         holds the item
--   user                  the recorded renter, lower-case; the zero address
--                         once the rental is cleared
--   expires               when the renter's right ends, unix seconds (the
--                         event's uint64, held at most at 2^53-1)
--   quantity              the units rented (decimal string; '1' for an
--                         ERC-721); '0' once cleared. A clearing keeps the row.
--   block_number,
--   log_index             the event that last updated the row; an update
--                         only lands when it is later than the stored one
--
-- Active means quantity <> '0' and expires after the time asked about. An
-- expiry needs no event, so a row stops being active by time alone.
--
-- Public by nature: every row restates one `VaultRentalUpdated` event. No
-- route joins this table to anything the platform keeps for a wallet.
-- Additive: a new table and its indexes only.
CREATE TABLE IF NOT EXISTS rental_rights (
  chain_id      INTEGER NOT NULL,
  loan_id       INTEGER NOT NULL,
  collection    TEXT    NOT NULL,
  token_id      TEXT    NOT NULL,
  owner         TEXT    NOT NULL,
  user          TEXT    NOT NULL,
  expires       INTEGER NOT NULL,
  quantity      TEXT    NOT NULL,
  block_number  INTEGER NOT NULL,
  log_index     INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (chain_id, loan_id)
);

-- The two feed reads: one collection (optionally one token), and one
-- collection with one user.
CREATE INDEX IF NOT EXISTS idx_rental_rights_collection
  ON rental_rights (chain_id, collection, loan_id);
CREATE INDEX IF NOT EXISTS idx_rental_rights_user
  ON rental_rights (chain_id, collection, user, loan_id);
