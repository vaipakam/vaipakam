-- #3688 — the set each NFT collection offer (#3328) takes, and whether its
-- published list checks out.
--
-- A collection offer is a lender offer (its row is in `offers`) that funds
-- up to `loans` loans of `per_loan` each, one per token in a set: the whole
-- collection (kind 1), a range of ids (kind 2, `low`..`high`) or a listed
-- set proven against `root` (kind 3). The contract stores a listed set's
-- `list_count` and `list_hash` as the lender gave them and never checks
-- them, so the indexer checks the published list against them (design
-- section 5): the canonical list file's keccak256 must be `list_hash`, the
-- file must name `list_count` distinct ids, and the sorted standard tree
-- over them must have `root`.
--
-- `list_check` is the result, and the book reads it:
--   'not_listed'     a collection or range set (nothing to check);
--   'ok'             the list checks out, and its file is served by hash;
--   'not_published'  no list yet (a large list arrives as a file, posted
--                    after the offer is created);
--   'empty' | 'duplicates' | 'count' | 'hash' | 'root'
--                    the published list does not match the offer.
-- A listed offer whose check is not 'ok' is kept out of the default book.
--
-- Replay-derived: every column comes from the creation event, except the
-- check of a file-backed list, which the indexer redoes from the list store
-- (object storage keyed by the hash) whenever the row is written. The store
-- itself is born off chain and is backed up separately.
--
-- Additive: a new table. The code still serving while it lands never names it.
CREATE TABLE IF NOT EXISTS collection_offer_set (
  chain_id        INTEGER NOT NULL,
  offer_id        INTEGER NOT NULL,
  lender          TEXT    NOT NULL,
  kind            INTEGER NOT NULL,
  per_loan        TEXT    NOT NULL,
  loans           INTEGER NOT NULL,
  low             TEXT    NOT NULL,
  high            TEXT    NOT NULL,
  root            TEXT    NOT NULL,
  list_count      INTEGER NOT NULL,
  list_hash       TEXT    NOT NULL,
  label           TEXT    NOT NULL,
  -- JSON array of decimal strings.
  exclusions      TEXT    NOT NULL,
  list_check      TEXT    NOT NULL,
  -- 'event' when the creation event carried the ids, 'file' when they came
  -- as a posted file, NULL while there is no list.
  list_source     TEXT,
  block_number    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (chain_id, offer_id)
);

-- The list route finds the offers a posted file belongs to by its hash.
CREATE INDEX IF NOT EXISTS idx_collection_offer_set_list_hash
  ON collection_offer_set (list_hash);
