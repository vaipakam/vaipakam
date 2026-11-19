-- 0115_position_token_ledger.sql — which offer or loan each position token
-- id ever stood for (#3021), so the NFT verifier can show a retired token's
-- history (`GET /positions/:tokenId`, src/positionHistoryRoute.ts).
--
-- `loans` and `offers` hold only a row's CURRENT token ids. A sale, a
-- takeover or an obligation handover retires the side's token and mints a
-- fresh one, and the loan row is repointed to the new id, so after it the old
-- token matches no row. This table keeps every id a row has ever held:
--
--   offer_id — the offer the token was minted for (NULL: minted for a loan);
--   loan_id  — the loan the token was a side of (an offer's token becomes the
--              loan's token at accept, so both may be set);
--   side     — 'lender' or 'borrower', the side the token stood for.
--
-- It is written by triggers on `loans` and `offers`, not by the handlers, so
-- every write path that sets a token id (the initiation insert, the heals,
-- the three migrations, any later one) records it without a second call to
-- forget. A token id is never reused on a chain, so a row is only ever filled
-- in, never moved to another position. The retirement itself is NOT stored
-- here: the route reads it from `activity_events`, so a reorged retirement
-- disappears with its event row.
--
-- Additive: one new table, its triggers, one partial index on the event
-- ledger, and a backfill of the ids the rows hold today. Ids a row held
-- before this migration and has since replaced are not recoverable from the
-- rows; the route answers "no record" for such a token rather than guess.
CREATE TABLE IF NOT EXISTS position_tokens (
  chain_id  INTEGER NOT NULL,
  token_id  TEXT    NOT NULL,
  offer_id  INTEGER,
  loan_id   INTEGER,
  side      TEXT CHECK (side IN ('lender', 'borrower')),
  PRIMARY KEY (chain_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_position_tokens_loan
  ON position_tokens(chain_id, loan_id) WHERE loan_id IS NOT NULL;

-- The route's retirement read: one probe on the token id inside the event's
-- JSON, partial on the one kind it reads.
CREATE INDEX IF NOT EXISTS idx_activity_position_retired_token
  ON activity_events(chain_id, json_extract(args_json, '$.tokenId'))
  WHERE kind = 'PositionRetired';

-- Offers: offer_type 0 = lender offer, 1 = borrower offer.
CREATE TRIGGER IF NOT EXISTS trg_position_tokens_offer_insert
AFTER INSERT ON offers
WHEN NEW.position_token_id IS NOT NULL AND NEW.position_token_id != '0'
BEGIN
  INSERT INTO position_tokens (chain_id, token_id, offer_id, side)
  VALUES (NEW.chain_id, NEW.position_token_id, NEW.offer_id,
          CASE NEW.offer_type WHEN 0 THEN 'lender' WHEN 1 THEN 'borrower' END)
  ON CONFLICT (chain_id, token_id) DO UPDATE
    SET offer_id = excluded.offer_id,
        side = COALESCE(position_tokens.side, excluded.side);
END;

CREATE TRIGGER IF NOT EXISTS trg_position_tokens_offer_update
AFTER UPDATE OF position_token_id ON offers
WHEN NEW.position_token_id IS NOT NULL AND NEW.position_token_id != '0'
BEGIN
  INSERT INTO position_tokens (chain_id, token_id, offer_id, side)
  VALUES (NEW.chain_id, NEW.position_token_id, NEW.offer_id,
          CASE NEW.offer_type WHEN 0 THEN 'lender' WHEN 1 THEN 'borrower' END)
  ON CONFLICT (chain_id, token_id) DO UPDATE
    SET offer_id = excluded.offer_id,
        side = COALESCE(position_tokens.side, excluded.side);
END;

-- Loans: a loan's side wins over the offer's guess (the token is the loan's
-- position from accept on).
CREATE TRIGGER IF NOT EXISTS trg_position_tokens_loan_lender_insert
AFTER INSERT ON loans
WHEN NEW.lender_token_id IS NOT NULL AND NEW.lender_token_id != '0'
BEGIN
  INSERT INTO position_tokens (chain_id, token_id, loan_id, side)
  VALUES (NEW.chain_id, NEW.lender_token_id, NEW.loan_id, 'lender')
  ON CONFLICT (chain_id, token_id) DO UPDATE
    SET loan_id = excluded.loan_id, side = excluded.side;
END;

CREATE TRIGGER IF NOT EXISTS trg_position_tokens_loan_borrower_insert
AFTER INSERT ON loans
WHEN NEW.borrower_token_id IS NOT NULL AND NEW.borrower_token_id != '0'
BEGIN
  INSERT INTO position_tokens (chain_id, token_id, loan_id, side)
  VALUES (NEW.chain_id, NEW.borrower_token_id, NEW.loan_id, 'borrower')
  ON CONFLICT (chain_id, token_id) DO UPDATE
    SET loan_id = excluded.loan_id, side = excluded.side;
END;

CREATE TRIGGER IF NOT EXISTS trg_position_tokens_loan_lender_update
AFTER UPDATE OF lender_token_id ON loans
WHEN NEW.lender_token_id IS NOT NULL AND NEW.lender_token_id != '0'
BEGIN
  INSERT INTO position_tokens (chain_id, token_id, loan_id, side)
  VALUES (NEW.chain_id, NEW.lender_token_id, NEW.loan_id, 'lender')
  ON CONFLICT (chain_id, token_id) DO UPDATE
    SET loan_id = excluded.loan_id, side = excluded.side;
END;

CREATE TRIGGER IF NOT EXISTS trg_position_tokens_loan_borrower_update
AFTER UPDATE OF borrower_token_id ON loans
WHEN NEW.borrower_token_id IS NOT NULL AND NEW.borrower_token_id != '0'
BEGIN
  INSERT INTO position_tokens (chain_id, token_id, loan_id, side)
  VALUES (NEW.chain_id, NEW.borrower_token_id, NEW.loan_id, 'borrower')
  ON CONFLICT (chain_id, token_id) DO UPDATE
    SET loan_id = excluded.loan_id, side = excluded.side;
END;

-- Backfill: the ids the rows hold today. Offers first, so a loan's side
-- overwrites an offer's on a token both name.
INSERT INTO position_tokens (chain_id, token_id, offer_id, side)
SELECT chain_id, position_token_id, offer_id,
       CASE offer_type WHEN 0 THEN 'lender' WHEN 1 THEN 'borrower' END
  FROM offers
 WHERE position_token_id IS NOT NULL AND position_token_id != '0'
ON CONFLICT (chain_id, token_id) DO NOTHING;

INSERT INTO position_tokens (chain_id, token_id, loan_id, side)
SELECT chain_id, lender_token_id, loan_id, 'lender'
  FROM loans
 WHERE lender_token_id IS NOT NULL AND lender_token_id != '0'
ON CONFLICT (chain_id, token_id) DO UPDATE
  SET loan_id = excluded.loan_id, side = excluded.side;

INSERT INTO position_tokens (chain_id, token_id, loan_id, side)
SELECT chain_id, borrower_token_id, loan_id, 'borrower'
  FROM loans
 WHERE borrower_token_id IS NOT NULL AND borrower_token_id != '0'
ON CONFLICT (chain_id, token_id) DO UPDATE
  SET loan_id = excluded.loan_id, side = excluded.side;
