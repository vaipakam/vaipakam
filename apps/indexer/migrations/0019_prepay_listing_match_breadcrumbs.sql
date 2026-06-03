-- T-086 Round-5 Block C v1.1 (#335)
-- ==================================
--
-- Analytics breadcrumb recording which OpenSea offer triggered a
-- prepay-listing Match-rotation. The on-chain `PrepayListingUpdated`
-- event the rotation emits doesn't carry the originating offer ID
-- (the rotation is just an order-shape update from the diamond's
-- POV; the dapp picks which offer to match against off-chain). To
-- distinguish "Match-from-OpenSea-offer rotation" from "manual
-- repricing" at analytics-query time, the dapp POSTs a breadcrumb
-- here after the rotation tx confirms.
--
-- Key shape: composite primary key `(chain_id, tx_hash)`. Loan IDs
-- in this codebase are scoped per chain (matching how
-- `prepay_listings` keys rows by `(chain_id, loan_id)`); a
-- tx_hash without chain_id would conflate breadcrumbs for the
-- same numeric loan on different chains. Each rotation tx is
-- unique within a chain, so the composite key admits one
-- breadcrumb per rotation per chain.
-- A single loan can rotate multiple times (different offers across
-- the loan's lifetime); each gets its own row. `(chain_id,
-- loan_id)` is separately indexed so the loan-history join is
-- cheap.
--
-- This is best-effort analytics data — the breadcrumb is NOT a
-- prerequisite for the Match flow. The dapp POSTs after the
-- rotation tx is mined; if the POST fails (network blip, indexer
-- down), the on-chain rotation is unaffected. Downstream analytics
-- queries treat the absence of a breadcrumb as "matched via the
-- manual repricing path" — the conservative interpretation.
--
-- No FK to `prepay_listings(order_hash)` or to the loan rows
-- because the indexer's reorg-windowed feed can serve the
-- pre-rotation Dutch row right up until the post tx lands —
-- a strict FK at insert time would race the indexer's
-- materialisation. The query-time join handles it.

CREATE TABLE IF NOT EXISTS prepay_listing_match_breadcrumbs (
    chain_id   INTEGER NOT NULL,
    tx_hash    TEXT    NOT NULL,
    loan_id    INTEGER NOT NULL,
    -- The OpenSea offer's canonical order hash the dapp matched
    -- against. Same shape the OpenSea Listings API uses.
    order_hash TEXT    NOT NULL,
    -- The OpenSea offer's bidder address (Seaport `offerer`).
    bidder     TEXT    NOT NULL,
    -- Unix seconds at the moment the dapp posted the breadcrumb
    -- (client-side clock). Used purely for ordering / display;
    -- correlation joins use `(chain_id, tx_hash)` against the
    -- indexer's materialised PrepayListingUpdated row.
    matched_at INTEGER NOT NULL,
    PRIMARY KEY (chain_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS prepay_listing_match_breadcrumbs_by_loan
    ON prepay_listing_match_breadcrumbs(chain_id, loan_id);
