-- T-041 Phase 1+2 — shared offer-book indexer schema.
--
-- Replaces (well, FRONTS — the per-browser logIndex.ts stays as
-- fallback) the per-browser eth_getLogs scan with a worker-side D1
-- cache. Browsers hit the worker's REST endpoints first; on
-- worker-down or any 5xx, fall through to the existing client-side
-- scan. Decentralization preserved: worker is a CACHE, not an
-- oracle. Every offer card carries a "verify on-chain" affordance
-- that triggers a direct Diamond read.
--
-- Indexer model:
--   - On each cron tick + on-demand backfill, scan `OfferCreated`,
--     `OfferAccepted`, `OfferCanceled`, `OfferCanceledDetails`
--     events from `last_block + 1` to head.
--   - For every newly-seen offerId, call the Diamond's
--     `getOfferDetails(id)` view function via JSON-RPC and persist
--     the full row to `offers`. Saves us from re-implementing
--     event decoding for every Offer struct field.
--   - Terminal events (`accepted`, `cancelled`) just flip the
--     status column. No need to re-fetch details.
--
-- Why mirror the full struct in the table (vs storing only IDs +
-- rehydrating on demand): the offer book renders all fields per
-- card. Mirroring the struct lets `/offers/active?limit=50` serve a
-- ready-to-render JSON page in one round trip; rehydrating per-row
-- would either burn the worker's CPU budget or push the latency
-- problem back onto the browser.

CREATE TABLE IF NOT EXISTS offers (
  -- Composite key: an offer id is unique only within a chain, so
  -- the primary key is `(chain_id, offer_id)`. Future multi-chain
  -- coverage already keys correctly.
  chain_id        INTEGER NOT NULL,
  offer_id        INTEGER NOT NULL,
  -- Lifecycle status — driven by terminal events.
  --   'active'    — OfferCreated seen, no terminal event yet
  --   'accepted'  — OfferAccepted seen
  --   'cancelled' — OfferCanceled seen
  --   'expired'   — duration elapsed without acceptance (computed,
  --                 not event-driven; reserved for future use)
  status          TEXT NOT NULL DEFAULT 'active',
  -- Address fields are lowercase 0x-hex (40 chars + 0x = 42).
  creator         TEXT NOT NULL,
  offer_type      INTEGER NOT NULL,    -- 0 = Lender, 1 = Borrower
  -- Asset fields, captured for offer-card rendering.
  lending_asset   TEXT NOT NULL,
  collateral_asset TEXT NOT NULL,
  asset_type      INTEGER NOT NULL,    -- LibVaipakam.AssetType enum
  collateral_asset_type INTEGER NOT NULL,
  -- LiquidityStatus per side. Determined at offer creation time
  -- (`OracleFacet.classifyAssetLiquidity`) and frozen — neither
  -- side's liquidity flips after the offer is on-chain. Stored
  -- separately from the AssetType columns above because the
  -- frontend's "Liquid only / Illiquid only" filter pivots on this
  -- field, not on AssetType.
  principal_liquidity INTEGER NOT NULL DEFAULT 1,
  collateral_liquidity INTEGER NOT NULL DEFAULT 1,
  token_id        TEXT NOT NULL DEFAULT '0',
  collateral_token_id TEXT NOT NULL DEFAULT '0',
  quantity        TEXT NOT NULL DEFAULT '0',
  collateral_quantity TEXT NOT NULL DEFAULT '0',
  -- Range Orders Phase 1: amount + rate carry both single-point AND
  -- min/max forms (when range is enabled). Storing both pairs keeps
  -- the row uniform regardless of the master-flag state.
  amount          TEXT NOT NULL,       -- bigint as string
  amount_max      TEXT NOT NULL DEFAULT '0',
  amount_filled   TEXT NOT NULL DEFAULT '0',
  interest_rate_bps INTEGER NOT NULL,
  interest_rate_bps_max INTEGER NOT NULL DEFAULT 0,
  collateral_amount TEXT NOT NULL,
  duration_days   INTEGER NOT NULL,
  position_token_id TEXT NOT NULL DEFAULT '0',
  prepay_asset    TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  -- Booleans flatten to integer for SQLite friendliness.
  use_full_term_interest INTEGER NOT NULL DEFAULT 0,
  creator_fallback_consent INTEGER NOT NULL DEFAULT 0,
  allows_partial_repay INTEGER NOT NULL DEFAULT 0,
  -- Bookkeeping: when did we first see this id, and at what block?
  first_seen_block INTEGER NOT NULL,
  first_seen_at   INTEGER NOT NULL,    -- unix seconds
  -- Updated whenever we re-fetch getOfferDetails() or flip status.
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (chain_id, offer_id)
);

-- Index for the primary read path: "list all active offers on chain
-- X". The status column is low-cardinality but the (chain, status)
-- composite index lets the frontend's `/offers/active` query do a
-- range scan in a single B-tree traversal.
CREATE INDEX IF NOT EXISTS idx_offers_chain_status
  ON offers(chain_id, status);

-- Index for the "my offers" view in the wallet menu — pulls every
-- offer a wallet ever created, regardless of status, ordered by
-- when they were created.
CREATE INDEX IF NOT EXISTS idx_offers_chain_creator
  ON offers(chain_id, creator);

-- Per-chain, per-table cursor for the indexer's "scan from
-- last_block + 1" loop. Separate row per (chain, kind) so we can
-- run distinct cursors for offers vs loans vs activity events
-- without serialising them into one cursor.
CREATE TABLE IF NOT EXISTS indexer_cursor (
  chain_id     INTEGER NOT NULL,
  kind         TEXT NOT NULL,        -- 'offers', 'loans', etc.
  last_block   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (chain_id, kind)
);
