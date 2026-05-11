-- 0012_current_holder.sql — track CURRENT NFT holder per loan/offer position,
-- separate from the LoanInitiated/OfferCreated-time `lender`/`borrower`/
-- `creator` columns which never update on secondary-market transfer.
--
-- Backing the /loans/by-current-holder/{addr} and
-- /offers/by-current-holder/{addr} read routes: these answer "what loans/
-- offers does this wallet's current NFT inventory translate to?" — covering
-- users who received a position NFT via ERC721 transfer rather than as the
-- original LoanInitiated / OfferCreated party.
--
-- The chainIndexer's ERC721 Transfer event handler maintains these columns
-- via a tokenId-keyed JOIN against (loans.lender_token_id |
-- loans.borrower_token_id) and offers.position_token_id. At LoanInitiated
-- and OfferCreated time the corresponding column is initialised to the
-- original participant (so the no-transfer case is correct out-of-the-box).
-- Subsequent Transfer events update only the matching row's current_owner
-- column.
--
-- Indexes on the current_owner columns make the by-current-holder routes
-- O(log N) at query time. Without them, the route would full-table-scan
-- the loans/offers tables on every request.

ALTER TABLE loans  ADD COLUMN lender_current_owner   TEXT NOT NULL DEFAULT '';
ALTER TABLE loans  ADD COLUMN borrower_current_owner TEXT NOT NULL DEFAULT '';
ALTER TABLE offers ADD COLUMN creator_current_owner  TEXT NOT NULL DEFAULT '';

-- Backfill existing rows: the no-transfer case is the common one, so the
-- initial current_owner equals the LoanInitiated/OfferCreated participant.
-- Any subsequent Transfer the indexer scans will overwrite as needed.
UPDATE loans  SET lender_current_owner   = lender   WHERE lender_current_owner   = '';
UPDATE loans  SET borrower_current_owner = borrower WHERE borrower_current_owner = '';
UPDATE offers SET creator_current_owner  = creator  WHERE creator_current_owner  = '';

CREATE INDEX IF NOT EXISTS idx_loans_lender_current_owner
  ON loans(chain_id, lender_current_owner);
CREATE INDEX IF NOT EXISTS idx_loans_borrower_current_owner
  ON loans(chain_id, borrower_current_owner);
CREATE INDEX IF NOT EXISTS idx_offers_creator_current_owner
  ON offers(chain_id, creator_current_owner);
