-- #3205 — a position NFT's transfer never blocks; instead every protocol flow
-- bound to a position completes only if that position's token has not moved
-- (any transfer, even away and back) since the flow opened. A flow whose
-- position moved can never complete. The chain has no view yet that says
-- "moved since opened" (#3323), so the indexer derives it from the
-- position-NFT `Transfer` events it already scans.
--
-- The flows and the side they bind:
--   borrower side — the collateral (prepay) listing (`prepay_listings`), the
--                   preclose offset offer, the swap-to-repay intent
--                   (`swap_to_repay_intents`) and the refinance request;
--   lender side   — the lender loan-sale listing (its sale offer).
--
-- The rule lives in ONE place, `src/positionFlowMoves.ts`: a flow has moved
-- when the side's LAST move, as (block, log index), is later than the point
-- the flow opened (or, for a collateral listing, was last posted or updated —
-- an update by the current holder re-arms it). This migration stores the two
-- halves of that comparison and nothing else; it computes no verdict.
--
-- Additive only: one new table, nullable columns. A NULL anchor means the
-- indexer cannot tell when the flow opened, and the routes say so (the field
-- is null, "cannot tell"), never "not moved".

-- The latest move of each loan side's position token: any Transfer whose
-- `from` is not the zero address (a mint is not a move; a burn is). One row
-- per (chain, loan, side); a later move replaces an earlier one.
CREATE TABLE IF NOT EXISTS position_side_moves (
  chain_id         INTEGER NOT NULL,
  loan_id          INTEGER NOT NULL,
  side             TEXT    NOT NULL CHECK (side IN ('lender', 'borrower')),
  -- The side's token id at the move (string-uint256).
  token_id         TEXT    NOT NULL,
  moved_block      INTEGER NOT NULL,
  moved_log_index  INTEGER NOT NULL,
  moved_tx_hash    TEXT    NOT NULL,
  -- Chain time of the move's block (unix seconds).
  moved_at         INTEGER NOT NULL,
  PRIMARY KEY (chain_id, loan_id, side)
);

-- The log index of the offer's `OfferCreated` (its block is
-- `first_seen_block`): the point an offset vehicle, a sale vehicle or a
-- refinance request opened. NULL = not known (a row from before this column).
ALTER TABLE offers ADD COLUMN created_log_index INTEGER;

-- The loan a lender-sale vehicle (`LoanSaleOfferLinked.loanId`) or an offset
-- vehicle (`OffsetOfferCreated.originalLoanId`) is bound to. NULL for every
-- other offer, and for a vehicle whose link event was not seen.
ALTER TABLE offers ADD COLUMN vehicle_loan_id INTEGER;

-- The (block, log index) of the intent's `SwapToRepayIntentCommitted`.
ALTER TABLE swap_to_repay_intents ADD COLUMN committed_block INTEGER;
ALTER TABLE swap_to_repay_intents ADD COLUMN committed_log_index INTEGER;

-- ── Backfill from the indexer's own event ledger ──────────────────────
-- `activity_events` holds every decoded log the indexer ingested, Transfers
-- included, so the anchors and the moves of rows that predate this migration
-- are recovered from it. Where a row's event is not there, its anchor stays
-- NULL and its verdict reads "cannot tell".

UPDATE offers
   SET created_log_index = (
     SELECT ae.log_index FROM activity_events ae
      WHERE ae.chain_id = offers.chain_id
        AND ae.kind = 'OfferCreated'
        AND ae.offer_id = offers.offer_id
        AND ae.block_number = offers.first_seen_block
      ORDER BY ae.log_index
      LIMIT 1
   )
 WHERE created_log_index IS NULL;

UPDATE offers
   SET vehicle_loan_id = (
     SELECT CAST(json_extract(ae.args_json, '$.loanId') AS INTEGER)
       FROM activity_events ae
      WHERE ae.chain_id = offers.chain_id
        AND ae.kind = 'LoanSaleOfferLinked'
        AND CAST(json_extract(ae.args_json, '$.saleOfferId') AS INTEGER) = offers.offer_id
      LIMIT 1
   )
 WHERE vehicle_loan_id IS NULL AND is_sale_vehicle = 1;

UPDATE offers
   SET vehicle_loan_id = (
     SELECT CAST(json_extract(ae.args_json, '$.originalLoanId') AS INTEGER)
       FROM activity_events ae
      WHERE ae.chain_id = offers.chain_id
        AND ae.kind = 'OffsetOfferCreated'
        AND CAST(json_extract(ae.args_json, '$.newOfferId') AS INTEGER) = offers.offer_id
      LIMIT 1
   )
 WHERE vehicle_loan_id IS NULL AND is_offset_vehicle = 1;

UPDATE swap_to_repay_intents
   SET committed_block = (
         SELECT ae.block_number FROM activity_events ae
          WHERE ae.chain_id = swap_to_repay_intents.chain_id
            AND ae.kind = 'SwapToRepayIntentCommitted'
            AND ae.tx_hash = swap_to_repay_intents.committed_tx_hash
            AND CAST(json_extract(ae.args_json, '$.loanId') AS INTEGER) = swap_to_repay_intents.loan_id
          LIMIT 1),
       committed_log_index = (
         SELECT ae.log_index FROM activity_events ae
          WHERE ae.chain_id = swap_to_repay_intents.chain_id
            AND ae.kind = 'SwapToRepayIntentCommitted'
            AND ae.tx_hash = swap_to_repay_intents.committed_tx_hash
            AND CAST(json_extract(ae.args_json, '$.loanId') AS INTEGER) = swap_to_repay_intents.loan_id
          LIMIT 1)
 WHERE committed_block IS NULL;

-- Each side's latest non-mint Transfer of its current token.
INSERT OR IGNORE INTO position_side_moves
  (chain_id, loan_id, side, token_id, moved_block, moved_log_index, moved_tx_hash, moved_at)
SELECT chain_id, loan_id, side, token_id, block_number, log_index, tx_hash, block_at
  FROM (
    SELECT s.chain_id, s.loan_id, s.side, s.token_id,
           ae.block_number, ae.log_index, ae.tx_hash, ae.block_at,
           ROW_NUMBER() OVER (
             PARTITION BY s.chain_id, s.loan_id, s.side
             ORDER BY ae.block_number DESC, ae.log_index DESC
           ) AS rn
      FROM (SELECT chain_id, loan_id, 'lender' AS side, lender_token_id AS token_id FROM loans
            UNION ALL
            SELECT chain_id, loan_id, 'borrower', borrower_token_id FROM loans) AS s
      JOIN activity_events ae
        ON ae.chain_id = s.chain_id
       AND ae.kind = 'Transfer'
       AND CAST(json_extract(ae.args_json, '$.tokenId') AS TEXT) = s.token_id
       AND lower(json_extract(ae.args_json, '$.from')) != '0x0000000000000000000000000000000000000000'
     WHERE s.token_id != '0'
  )
 WHERE rn = 1;
