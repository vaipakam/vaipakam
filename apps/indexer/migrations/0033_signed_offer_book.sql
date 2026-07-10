-- 0033_signed_offer_book.sql — Rate Desk phase 3 (#1131): the INDEXER-side
-- signed-offer book (the off-chain half of the v0.5/v0.6 signed-offer
-- contracts — SignedOfferBookV05Design.md §1 explicitly scoped the book OUT
-- of the contract PR to apps/indexer; this is that slice).
--
-- One table. A signed offer is an EIP-712-signed, gasless order that lives
-- ONLY here until a counterparty fills it on-chain (SignedOfferFacet /
-- OfferMatchFacet). The row therefore stores TWO things:
--
--   1. The REPLAY PAYLOAD — `order_json` (the exact 28-field SignedOffer
--      object as submitted: bigints as decimal strings, addresses lowercase)
--      + `signature`. This is what a taker feeds verbatim into
--      `acceptSignedOffer` / `matchSignedOffer`; the indexer must never
--      reshape it (the EIP-712 digest binds every field — see
--      contracts/src/libraries/LibSignedOffer.sol:39-68).
--
--   2. PROMOTED scoping/lifecycle columns for the market read path — the
--      desk queries by (lending_asset, collateral_asset, duration_days) the
--      same way it scopes `offers` (0029), and the lifecycle handlers in
--      chainIndexer.ts flip status / accumulate filled_amount from the
--      SignedOfferFilled / SignedOfferMatched / SignedOfferCancelled /
--      SignedOfferNonceBurned events.
--
-- Key: `order_hash` is the EIP-712 STRUCT hash (`signedOfferOrderHash`, NOT
-- the full digest) — the same domain-independent key the on-chain
-- `signedOfferFilled` ledger uses, so a chain event's indexed orderHash
-- addresses the row directly. PK (chain_id, order_hash): the struct hash is
-- domain-independent by construction, so the SAME order signed for two
-- chains hashes identically — chain_id disambiguates.
--
-- uint256 money-shaped values (amount*, collateral*, filled_amount, nonce)
-- are TEXT decimal strings (repo convention — offers.amount etc.);
-- duration_days / expires_at / deadline are INTEGER (bounded at ingest:
-- duration <= 4385, timestamps <= year-9999 sanity bound).
--
-- D1 schema discipline (CLAUDE.md): this file is the single source of truth
-- for the table; apply with
--   cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote
-- — never `wrangler d1 execute --command "CREATE TABLE ..."` on the live db.

CREATE TABLE IF NOT EXISTS signed_offers (
  chain_id              INTEGER NOT NULL,
  order_hash            TEXT    NOT NULL,   -- EIP-712 struct hash, lowercase 0x-64-hex
  signer                TEXT    NOT NULL,   -- lowercase 0x-40-hex
  order_json            TEXT    NOT NULL,   -- canonical 28-field SignedOffer JSON
  signature             TEXT    NOT NULL,   -- signer's EIP-712 signature, 0x-hex

  -- Promoted scoping columns (mirror the order_json values; queryable).
  offer_type            INTEGER NOT NULL,   -- LibVaipakam.OfferType (0 lender / 1 borrower)
  lending_asset         TEXT    NOT NULL,   -- lowercase
  collateral_asset      TEXT    NOT NULL,   -- lowercase
  duration_days         INTEGER NOT NULL,
  asset_type            INTEGER NOT NULL,   -- LibVaipakam.AssetType (lent leg)
  collateral_asset_type INTEGER NOT NULL,
  interest_rate_bps     INTEGER NOT NULL,   -- min / single-value
  interest_rate_bps_max INTEGER NOT NULL,   -- range max (0 = single-value)
  amount                TEXT    NOT NULL,   -- min / single-value principal
  amount_max            TEXT    NOT NULL,   -- range max ('0' = collapse to amount)
  collateral_amount     TEXT    NOT NULL,
  collateral_amount_max TEXT    NOT NULL,
  fill_mode             INTEGER NOT NULL,   -- LibVaipakam.FillMode (0 Partial / 1 Aon / 2 Ioc)
  expires_at            INTEGER NOT NULL,   -- GTT offer expiry, unix seconds (0 = GTC)
  deadline              INTEGER NOT NULL,   -- signature validity deadline (0 = no deadline)
  nonce                 TEXT    NOT NULL,   -- per-signer batch-cancel nonce (uint256 decimal)

  -- Lifecycle projection (chainIndexer.ts signed-offer handlers).
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'filled', 'cancelled', 'nonce_burned')),
  filled_amount TEXT NOT NULL DEFAULT '0',  -- cumulative principal filled (decimal string)

  created_at INTEGER NOT NULL,              -- indexer ingest clock, unix seconds
  updated_at INTEGER NOT NULL,

  PRIMARY KEY (chain_id, order_hash)
);

-- Market read path: GET /signed-offers scopes on (chainId, status='active',
-- pair, tenor) — same market-triple shape as idx_offers_market (0029).
CREATE INDEX IF NOT EXISTS idx_signed_offers_market
  ON signed_offers (chain_id, status, lending_asset, collateral_asset, duration_days);

-- Signer lookup: SignedOfferNonceBurned flips every (signer, nonce) row, and
-- a future "my signed offers" view reads by signer.
CREATE INDEX IF NOT EXISTS idx_signed_offers_signer
  ON signed_offers (chain_id, signer);
