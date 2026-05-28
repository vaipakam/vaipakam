-- 2026-05-28 — T-086 step 12: persist Seaport prepay-collateral-
-- listing state so the frontend can render "your loan has a live
-- listing" + a cancel CTA from indexer rows alone, no per-loan
-- on-chain getPrepayListingOrderHash() probe.
--
-- One row per LIVE listing per loan; deleted on cancel /
-- cancelExpired / successful Seaport fill (the executor's
-- post-fill `executorFinalizePrepaySale` emits
-- PrepayCollateralSaleSettled which triggers the DELETE).
--
-- `loan_id` is unique because at most ONE listing per loan is
-- live at a time (the facet enforces this — update REPLACES
-- the orderHash).
--
-- `chain_id` matches the schema convention of every other
-- per-row table so the same D1 holds cross-chain rows.

CREATE TABLE IF NOT EXISTS prepay_listings (
  -- Composite primary identification.
  chain_id            INTEGER NOT NULL,
  loan_id             INTEGER NOT NULL,

  -- Listing payload (immutable per row; updates DELETE the old
  -- row + INSERT a fresh one, mirroring the on-chain orderHash
  -- rotation semantic of `updatePrepayListing`).
  order_hash          TEXT    NOT NULL,
  ask_price           TEXT    NOT NULL,  -- string-uint256, like other amount columns
  conduit             TEXT    NOT NULL,  -- 0x-prefixed lowercase
  -- NOTE: the listing's pinned executor address is NOT persisted
  -- here. The on-chain event payload (`PrepayListingPosted` /
  -- `PrepayListingUpdated`) doesn't carry it; the diamond stores
  -- it in `s.prepayListingExecutor[loanId]`. Storing the diamond
  -- address as a placeholder would be misleading — the frontend
  -- queries the diamond's view directly when it needs the
  -- pinned executor (rare today; only after governance has
  -- actively rotated). See Codex P2 round-1 on PR #304.

  -- Lister identity (current borrower-position-NFT holder at post
  -- time). NOT necessarily the loan's `borrower` (the original EOA
  -- that opened the loan) — position-NFT transferability means the
  -- lister can be a downstream holder.
  lister              TEXT    NOT NULL,

  -- Chain-time anchors. `posted_at` is when the diamond recorded
  -- the listing; `updated_at` lets the frontend show "Updated 3h
  -- ago" for re-signs; `grace_period_end` is the absolute Unix
  -- timestamp past which the listing becomes uncancellable via
  -- the borrower path (and starts the permissionless-cleanup
  -- window).
  posted_at           INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  grace_period_end    INTEGER NOT NULL,

  -- Per-row provenance.
  block_number        INTEGER NOT NULL,
  tx_hash             TEXT    NOT NULL,
  log_index           INTEGER NOT NULL,

  PRIMARY KEY (chain_id, loan_id)
);

-- Reverse lookup for the indexer's update / cancel handlers
-- (they receive an orderHash on the cancel event, need to find
-- the matching row).
CREATE INDEX IF NOT EXISTS idx_prepay_listings_order_hash
  ON prepay_listings(chain_id, order_hash);

-- Reverse lookup for the frontend "my listings" view ("show me
-- every loan I'm currently listing").
CREATE INDEX IF NOT EXISTS idx_prepay_listings_lister
  ON prepay_listings(chain_id, lister);
