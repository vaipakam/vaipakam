-- 0030_backfill_sale_vehicle_flags.sql — backfill is_sale_vehicle for rows
-- that predate migration 0029 (Codex #1134 round-2 P2).
--
-- 0029 added the `is_sale_vehicle` columns (DEFAULT 0) and the live
-- `LoanSaleOfferLinked` handler in chainIndexer.ts marks NEW sale offers as
-- their events arrive — but the ingest cursor never replays old logs, so
-- every lender-sale vehicle indexed BEFORE the 0029 deploy stays flagged 0
-- forever and keeps leaking into /offers/markets, the market-filtered
-- feeds, and the desk's book/tape. A NEW migration (not an edit to 0029)
-- because 0029 may already be applied on a deployed database — wrangler's
-- migrations journal replays only unapplied files.
--
-- Provenance of the backfill source: `activity_events` is the append-only
-- ledger of EVERY decoded log, including historical `LoanSaleOfferLinked`
-- rows. `pluckActivityRefs` has no case for that kind (falls through to
-- the default), so those rows carry offer_id = NULL / loan_id = NULL — the
-- sale offer id lives only in args_json. `serializeArgs` coerces bigints
-- to decimal strings ("saleOfferId": "17"), so CAST the extracted TEXT to
-- INTEGER to match the integer offer_id column. Scope by the event row's
-- own chain_id. Idempotent: only flips rows still at 0.

-- 1. Offer-side flag — mirrors the live LoanSaleOfferLinked handler.
UPDATE offers
   SET is_sale_vehicle = 1,
       updated_at = unixepoch()
 WHERE is_sale_vehicle = 0
   AND EXISTS (
     SELECT 1 FROM activity_events ae
      WHERE ae.kind = 'LoanSaleOfferLinked'
        AND ae.chain_id = offers.chain_id
        AND CAST(json_extract(ae.args_json, '$.saleOfferId') AS INTEGER)
              = offers.offer_id
   );

-- 2. Loan-side flag — mirrors the live LoanInitiated propagation (the temp
--    bookkeeping loan a sale vehicle initiates keys on the sale offer's id).
UPDATE loans
   SET is_sale_vehicle = 1
 WHERE is_sale_vehicle = 0
   AND EXISTS (
     SELECT 1 FROM offers o
      WHERE o.chain_id = loans.chain_id
        AND o.offer_id = loans.offer_id
        AND o.is_sale_vehicle = 1
   );
