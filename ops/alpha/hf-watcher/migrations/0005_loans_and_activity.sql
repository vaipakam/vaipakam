-- T-041 Phase B — loans + unified activity-event ledger.
--
-- Schema design notes:
--
-- 1. `loans` mirrors `Loan` from `LibVaipakam` for frontend
--    rendering. Asset metadata (lending_asset, collateral_asset,
--    asset_type, etc.) ARRIVES via JOIN from the `offers` table on
--    `offer_id`, NOT via a parallel scan of LoanInitiated event
--    payload — that's the cross-domain reuse the Phase B handler
--    relies on. When LoanInitiated fires, the row is written with
--    the offer-side fields pulled from `offers` in the same DB
--    transaction. Phase A's offer-detail refresh has already
--    populated those fields by the time Phase B is processing the
--    loan event.
--
-- 2. `activity_events` is the unified append-only event ledger that
--    powers the Activity page, LoanTimeline component, and any
--    future per-actor/per-domain filters. Rows from Phase A
--    (OfferCreated / OfferAccepted / OfferCanceled) AND Phase B
--    (LoanInitiated / LoanRepaid / PartialRepaid / LoanDefaulted /
--    LoanLiquidated / LoanSettlementBreakdown) ALL land here so the
--    Activity page is one paginated query, not a fan-out join.
--    args_json carries the raw decoded event args for fallback
--    rendering when the per-kind columns aren't enough.
--
-- 3. Indexes are scoped by (chain_id, ...) so multi-chain coverage
--    in a follow-up doesn't need schema changes.

CREATE TABLE IF NOT EXISTS loans (
  chain_id        INTEGER NOT NULL,
  loan_id         INTEGER NOT NULL,
  offer_id        INTEGER NOT NULL,
  -- Lifecycle status — driven by terminal events.
  --   'active'      — LoanInitiated seen, no terminal event yet
  --   'repaid'      — LoanRepaid seen
  --   'defaulted'   — LoanDefaulted seen
  --   'liquidated'  — LoanLiquidated seen
  --   'settled'     — distinct terminal: post-default settled (claim
  --                    pulls from forfeit pool) or graceful close
  status          TEXT NOT NULL DEFAULT 'active',
  lender          TEXT NOT NULL,
  borrower        TEXT NOT NULL,
  principal       TEXT NOT NULL,        -- bigint as string
  collateral_amount TEXT NOT NULL,
  -- Asset metadata mirrored from the matching `offers` row at
  -- LoanInitiated time. Cached here so loan rendering doesn't need
  -- a JOIN per row. Offer fields can change before loan init only
  -- via the offer's range bounds (no asset-shape changes after
  -- creation), so this snapshot is stable for the loan's lifetime.
  asset_type      INTEGER NOT NULL DEFAULT 0,
  collateral_asset_type INTEGER NOT NULL DEFAULT 0,
  lending_asset   TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  collateral_asset TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
  duration_days   INTEGER NOT NULL DEFAULT 0,
  token_id        TEXT NOT NULL DEFAULT '0',
  collateral_token_id TEXT NOT NULL DEFAULT '0',
  start_block     INTEGER NOT NULL,
  start_at        INTEGER NOT NULL,     -- unix seconds
  -- Filled at terminal-event time. NULL while loan is active.
  terminal_block  INTEGER,
  terminal_at     INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (chain_id, loan_id)
);

-- Active loans by chain — Dashboard "Your Loans" + Risk Watch.
CREATE INDEX IF NOT EXISTS idx_loans_chain_status
  ON loans(chain_id, status);

-- Per-wallet lookups. Both sides of the loan are queried; the
-- wallet menu's "My Loans" view runs OR(lender, borrower) which
-- SQLite's planner serves with one index per side.
CREATE INDEX IF NOT EXISTS idx_loans_chain_lender
  ON loans(chain_id, lender);
CREATE INDEX IF NOT EXISTS idx_loans_chain_borrower
  ON loans(chain_id, borrower);

-- Unified per-event ledger. Append-only; no row is ever updated.
-- (chain_id, block_number, log_index) is globally unique on EVM.
CREATE TABLE IF NOT EXISTS activity_events (
  chain_id        INTEGER NOT NULL,
  block_number    INTEGER NOT NULL,
  log_index       INTEGER NOT NULL,
  tx_hash         TEXT NOT NULL,
  kind            TEXT NOT NULL,        -- 'OfferCreated', 'LoanInitiated', etc.
  -- Optional cross-domain references. NULL when not applicable.
  loan_id         INTEGER,
  offer_id        INTEGER,
  -- The relevant participant for "my activity" filters. Per-event
  -- semantics:
  --   OfferCreated      → creator
  --   OfferAccepted     → acceptor
  --   OfferCanceled     → creator
  --   LoanInitiated     → borrower (lender appears separately as a
  --                       second row OR via the loans-table JOIN)
  --   LoanRepaid        → repayer
  --   LoanDefaulted     → NULL (system-driven)
  --   LoanLiquidated    → NULL (liquidator captured in args_json)
  actor           TEXT,
  -- Full decoded args as JSON for fallback rendering. The key columns
  -- above are what the Activity page filters on; args_json is what it
  -- displays after a row is selected.
  args_json       TEXT NOT NULL,
  block_at        INTEGER NOT NULL,     -- block timestamp, unix seconds
  PRIMARY KEY (chain_id, block_number, log_index)
);

-- Newest-first scan by chain. Activity page lands here.
CREATE INDEX IF NOT EXISTS idx_activity_chain_block
  ON activity_events(chain_id, block_number DESC, log_index DESC);
-- Per-loan timeline (LoanDetails / LoanTimeline).
CREATE INDEX IF NOT EXISTS idx_activity_chain_loan
  ON activity_events(chain_id, loan_id, block_number DESC);
-- Per-offer history.
CREATE INDEX IF NOT EXISTS idx_activity_chain_offer
  ON activity_events(chain_id, offer_id, block_number DESC);
-- Per-wallet activity feed.
CREATE INDEX IF NOT EXISTS idx_activity_chain_actor
  ON activity_events(chain_id, actor, block_number DESC);
-- Activity page filter-by-kind tab.
CREATE INDEX IF NOT EXISTS idx_activity_chain_kind
  ON activity_events(chain_id, kind, block_number DESC);
