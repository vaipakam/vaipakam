-- T-086 Round-5 Block B (Issue #309)
-- ===================================
--
-- The PrepayListingPosted / PrepayListingUpdated events grew three
-- additional non-indexed fields when Block B's Dutch-decay entry
-- points landed:
--
--   `endAskPrice`    uint256 — wei. For fixed-price posts equals
--                              `askPrice`; for Dutch is the floor
--                              of the decaying borrower-leg.
--   `auctionEndTime` uint256 — Unix seconds. For fixed-price posts
--                              is 0 (sentinel: cancel-time
--                              reconstruction reads `pctx.graceEnd`
--                              instead). For Dutch is the Seaport
--                              `OrderComponents.endTime`.
--   `mode`           uint8   — 0 = fixed-price, 1 = Dutch.
--                              Single discriminator the dapp +
--                              indexer use to pick the right
--                              renderer / cancel-time
--                              reconstruction shape.
--
-- The columns persist the as-emitted values for analytics +
-- autonomous-republish retry. They are nullable to remain
-- backward-compatible with rows materialised before this
-- migration (every pre-Block-B row stays untouched; the indexer's
-- INSERT/UPDATE writes the new shape for every row after).
--
-- No column rename. `prepay_listings.ask_price` continues to mean
-- "start ask"; Block B's Dutch posts emit `askPrice == startAskPrice`
-- per the event shape (see NFTPrepayListingFacet `_buildAndRecordDutch`).

ALTER TABLE prepay_listings ADD COLUMN end_ask_price TEXT;
ALTER TABLE prepay_listings ADD COLUMN auction_end_time INTEGER;
ALTER TABLE prepay_listings ADD COLUMN auction_mode INTEGER;
