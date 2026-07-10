-- 0031_offset_vehicle_flags.sql — mark Preclose Option-3 OFFSET vehicles
-- (Codex #1134 round-5 P2).
--
-- An offset vehicle is the LENDER-side replacement offer the borrower posts
-- via `PrecloseFacet.offsetWithNewOffer` (Preclose Option 3). It goes through
-- the normal `createOfferInternal` path, so it lands in `offers` as a live
-- ERC20/ERC20 lender row — but its terms are pinned to an existing loan
-- (OfferMutateFacet freezes it, acceptance settles the ORIGINAL loan), so it
-- is bookkeeping, never quotable market liquidity. Without a flag, a market
-- whose only row is an offset vehicle gets advertised by /offers/markets and
-- auto-selected by the desk, which then (correctly) renders an empty book.
-- Same shape as the 0029 `is_sale_vehicle` marker for borrower-style
-- lender-sale vehicles; a separate column because the two link kinds are
-- distinct on-chain mappings (`offsetOfferToLoanId` vs `saleOfferToLoanId`)
-- and consumers may need to tell them apart.
--
-- Offers-only: the offset offer's eventual acceptance re-originates a REAL
-- replacement loan at the posted terms (a genuine rate print), unlike the
-- lender-sale temp bookkeeping loan — so no loans-side column here.

-- 1. Offset-vehicle marker (0 = real quotable offer). The live
--    `OffsetOfferCreated` handler in chainIndexer.ts sets it for new events.
ALTER TABLE offers ADD COLUMN is_offset_vehicle INTEGER NOT NULL DEFAULT 0;

-- 2. Backfill rows indexed BEFORE this deploy — the ingest cursor never
--    replays old logs (same rationale as 0030's sale-vehicle backfill).
--
-- Provenance of the backfill source: `activity_events` is the append-only
-- ledger of EVERY decoded log, including historical `OffsetOfferCreated`
-- rows (PrecloseFacet.sol:126 — `event OffsetOfferCreated(uint256 indexed
-- originalLoanId, uint256 indexed newOfferId, address indexed borrower,
-- uint256 shortfallPaid)`). `pluckActivityRefs` has no case for that kind
-- (falls through to the default), so those rows carry offer_id = NULL — the
-- offer id lives only in args_json. `serializeArgs` coerces bigints to
-- decimal strings ("newOfferId": "17"), so CAST the extracted TEXT to
-- INTEGER to match the integer offer_id column. Scope by the event row's
-- own chain_id. Idempotent: only flips rows still at 0.
UPDATE offers
   SET is_offset_vehicle = 1,
       updated_at = unixepoch()
 WHERE is_offset_vehicle = 0
   AND EXISTS (
     SELECT 1 FROM activity_events ae
      WHERE ae.kind = 'OffsetOfferCreated'
        AND ae.chain_id = offers.chain_id
        AND CAST(json_extract(ae.args_json, '$.newOfferId') AS INTEGER)
              = offers.offer_id
   );
