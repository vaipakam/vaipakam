-- #600 — backfill activity_events.offer_id / loan_id for OfferMatched rows.
--
-- Before this change, `pluckActivityRefs` had no `OfferMatched` case and fell
-- through to the default, so every OfferMatched activity row was stored with
-- offer_id = NULL and loan_id = NULL. A matcher-driven fill of a LENDER offer
-- attributes the child loan to the BORROWER offer everywhere else (the loan's
-- own offerId and its companion OfferAccepted), so this event is the lender
-- offer's ONLY link to that child loan. OfferDetails' "Loans from this offer"
-- section reads `/activity?offerId=<lenderId>&kind=OfferMatched` to enumerate
-- matched children, so rows indexed before the denormalization need their refs
-- restored from the preserved args bag.
--
-- args_json serializes bigints as decimal strings (indexer `serializeArgs`),
-- so CAST the extracted values to INTEGER to match the integer columns.
-- Idempotent: only touches rows still NULL, and only when the args are present.
UPDATE activity_events
SET offer_id = CAST(json_extract(args_json, '$.lenderOfferId') AS INTEGER),
    loan_id  = CAST(json_extract(args_json, '$.loanId') AS INTEGER)
WHERE kind = 'OfferMatched'
  AND offer_id IS NULL
  AND json_extract(args_json, '$.lenderOfferId') IS NOT NULL
  AND json_extract(args_json, '$.loanId') IS NOT NULL;
