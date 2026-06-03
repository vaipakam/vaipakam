-- T-086 Round-6 / Block D (#345)
-- ===============================
--
-- Adds a `match_mode` column to `prepay_listing_match_breadcrumbs`
-- so the analytics surface can distinguish between the two Match
-- paths:
--
--   - 'v1-twostep' (default; written by the dapp-side POST that
--     #335 introduced): borrower clicked Match → dapp called
--     `updatePrepayListing(newAsk = offer_value)` → bidder
--     separately fulfilled the rotated listing. Race window for
--     a third-party snipe between rotation tx and bidder's
--     fulfillOrder.
--
--   - 'atomic' (written by the indexer's `PrepayListingMatched`
--     event handler, NOT by the dapp): borrower clicked Match →
--     dapp called `NFTPrepayListingAtomicFacet.matchOpenSeaOffer`
--     → Seaport.matchAdvancedOrders settled both the bidder's
--     signed Offer AND the Vaipakam counter-order in one atomic
--     tx. No race window.
--
-- Round-6 design doc §17.18 D.1 / D.3 specifies this storage
-- location (NOT `prepay_listings.matched_via`, because the
-- `PrepayCollateralSaleSettled` handler at
-- chainIndexer.ts:2068-2079 deletes the `prepay_listings` row in
-- the same tx — the breadcrumb table survives terminal cleanup
-- and is the durable surface for the Match-mode signal).
--
-- The atomic path does NOT fire the #335 dapp-side POST (race-
-- window prevention per §17.13 of the design doc — the on-chain
-- `PrepayListingMatched` event carries everything the breadcrumb
-- needs, and an INSERT OR REPLACE from the POST could overwrite
-- the event-sourced 'atomic' value with the default 'v1-twostep').
--
-- Existing rows get the default 'v1-twostep'. New v1-twostep
-- POSTs continue to take the default. New PrepayListingMatched
-- events from the on-chain handler explicitly write 'atomic'.

ALTER TABLE prepay_listing_match_breadcrumbs
    ADD COLUMN match_mode TEXT
    NOT NULL
    DEFAULT 'v1-twostep'
    CHECK (match_mode IN ('v1-twostep', 'atomic'));
