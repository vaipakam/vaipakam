-- #2528 — record which loan a refinance request is for.
--
-- A borrower asks to refinance a running loan by posting a borrower offer
-- tagged with that loan's id (the offer's `refinanceTargetLoanId`, fixed at
-- creation and never changed afterwards). A lender who accepts it funds a new
-- loan that repays the old one. The Offer Book could not say so: the indexer
-- stored no trace of the tag, so a refinance request read as an ordinary
-- borrow request.
--
--   refinance_target_loan_id — the loan the request refinances; 0 when the
--                              offer is not a refinance request; NULL when
--                              the indexer has not read it (a stub row, or a
--                              row indexed before this migration that the
--                              backfill below could not reach). NULL is
--                              UNKNOWN, never "not a refinance".
--
-- Additive: one NULLable column; the deployed code neither reads nor writes
-- it.
ALTER TABLE offers ADD COLUMN refinance_target_loan_id INTEGER;

-- Backfill rows indexed BEFORE this deploy: the ingest cursor never replays
-- old logs (the 0030 / 0031 rationale). The source is the offer's own
-- `OfferCreatedDetails` log in the append-only `activity_events` ledger,
-- which carries the tag as `fields.refinanceTargetLoanId`. `serializeArgs`
-- writes bigints as decimal strings, so the extracted TEXT is CAST to
-- INTEGER. One join rather than a per-offer subquery: those ledger rows carry
-- no `offer_id` column value (the offer id is only in `args_json`), so a
-- correlated lookup would re-scan every such row once per offer. Matched on
-- the event row's own chain_id. Idempotent: only fills rows still NULL, and a
-- row with no such log (or a log shape without the field) stays NULL, unknown.
--
-- The backfill is an accelerator, not the guarantee. This migration lands while
-- the previous build is still serving, and that build can insert or heal an
-- offer without writing the column. The new build's detail-refresh lane
-- therefore also selects every ACTIVE offer whose tag is still NULL and reads
-- it from chain, so a row written in that window is completed on a later pass
-- (Codex #2661 r1). Rows the backfill fills here never need that read.
UPDATE offers
   SET refinance_target_loan_id = src.target
  FROM (
    SELECT chain_id,
           CAST(json_extract(args_json, '$.offerId') AS INTEGER) AS offer_id,
           CAST(json_extract(args_json, '$.fields.refinanceTargetLoanId') AS INTEGER) AS target
      FROM activity_events
     WHERE kind = 'OfferCreatedDetails'
       AND json_extract(args_json, '$.fields.refinanceTargetLoanId') IS NOT NULL
  ) AS src
 WHERE offers.refinance_target_loan_id IS NULL
   AND offers.chain_id = src.chain_id
   AND offers.offer_id = src.offer_id;
