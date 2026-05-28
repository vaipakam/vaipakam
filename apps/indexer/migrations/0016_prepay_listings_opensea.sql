-- 2026-05-29 — T-086 step 14: extend `prepay_listings` with the
-- borrower-supplied salt + conduitKey + the indexer's autonomous
-- OpenSea republish bookkeeping.
--
-- The on-chain `PrepayListingPosted` / `PrepayListingUpdated`
-- events now emit `conduitKey` and `salt` (NFTPrepayListingFacet
-- step-14 contract change). The indexer parses both, persists
-- them here, and uses them to autonomously rebuild the canonical
-- Seaport `OrderComponents` and POST to OpenSea's Listings API —
-- closing the close-browser edge case that the dapp's
-- frontend-direct publish path couldn't cover by itself.
-- (#311 — the design card for this layer.)
--
-- `opensea_published_at` records when the autonomous republish
-- (or the dapp's immediate POST) was last accepted by OpenSea's
-- API. NULL means "still need to push"; non-NULL means "already
-- on OpenSea's book at least once". The indexer's republish loop
-- skips rows whose flag is set.
--
-- D1 column-add is `ALTER TABLE ADD COLUMN` — sqlite-compatible,
-- no rewrite needed; existing rows get the default NULL.

ALTER TABLE prepay_listings ADD COLUMN conduit_key TEXT;
ALTER TABLE prepay_listings ADD COLUMN salt TEXT;
ALTER TABLE prepay_listings ADD COLUMN opensea_published_at INTEGER;
-- The pinned executor address used to build the order. Emitted on
-- the new step-14 event payload; persisted here so the retry-sweep
-- path (see `_sweepUnpublishedListings` in `chainIndexer.ts`) has
-- the value it needs to reconstruct the canonical components even
-- after a governance executor rotation invalidates
-- `getCollateralListingExecutor()` for this order's purposes.
ALTER TABLE prepay_listings ADD COLUMN executor TEXT;

-- For the autonomous republish loop's "rows that still need to push"
-- query: scan by chain + null-published. Without an index the
-- scanner full-table-scans every Posted row on every tick.
CREATE INDEX IF NOT EXISTS idx_prepay_listings_needs_publish
  ON prepay_listings(chain_id, opensea_published_at)
  WHERE opensea_published_at IS NULL;
