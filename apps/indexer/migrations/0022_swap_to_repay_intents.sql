-- 2026-06-08 — T-090 v1.1 (#389) Sub 2 (#417): persist v1.1 intent-
-- based swap-to-repay commit state so the frontend can render
-- "your loan has a pending intent commit" + a cancel CTA from
-- indexer rows alone (no per-loan on-chain getIntentCommit() probe).
--
-- One row per LIVE intent commit per loan; deleted on:
--   • fill (postInteraction emits SwapToRepayIntentFilled)
--   • borrower cancel (cancelSwapToRepayIntent → SwapToRepayIntentCancelled)
--   • permissionless cancel (cancelExpiredIntent → SwapToRepayIntentCancelled)
--   • force-cancel from liquidation / time-default paths
--     (SwapToRepayIntentForceCancelled)
--
-- `loan_id` is the composite-PK partner of `chain_id` because the
-- v1.1 facet's no-double-commit guard
-- (`IntentAlreadyCommitted(loanId)`) enforces at most ONE live
-- commit per loan at any time — a fresh commit must teardown the
-- previous one first.
--
-- Sub 2 deferral note (mirrors the contracts-side Sub 1 commit's
-- DELIBERATELY_NOT_HANDLED entries that this PR removes): the four
-- `SwapToRepayIntent*` events are NOW handled. Once this migration
-- lands and the new `chainIndexer.ts` handler dispatches, the
-- `check-event-coverage.mjs` allowlist entries for these four
-- events are removed in the same PR.
--
-- `chain_id` matches the schema convention of every other per-row
-- table so the same D1 holds cross-chain rows (the indexer + agent
-- + keeper Workers all share `vaipakam-archive`).
CREATE TABLE IF NOT EXISTS swap_to_repay_intents (
  -- Composite primary identification.
  chain_id            INTEGER NOT NULL,
  loan_id             INTEGER NOT NULL,

  -- Canonical 1inch LOP v4 order hash — the lookup key the dapp
  -- uses to poll Fusion for fill status. Mirrors the on-chain
  -- `intentCommits[loanId].orderHash` field, which is also the
  -- primary key the diamond's ERC-1271 + pre/postInteraction hooks
  -- look up against.
  order_hash          TEXT    NOT NULL,

  -- Commit-time borrower-NFT holder (the v1.1 facet records this
  -- as `committedByForRecord`; later authority decisions follow
  -- the CURRENT NFT owner via on-chain `ownerOf`, but the activity
  -- feed attributes the commit to the address that originated it).
  -- 0x-prefixed lowercase address.
  committed_by        TEXT    NOT NULL,

  -- Fusion order amounts (string-uint256 because ERC20 amounts
  -- routinely exceed 2^63, the cap on D1's INTEGER type).
  -- `maker_amount` equals the post-vault-withdraw custodial
  -- collateral the diamond holds; for v1.1 this also equals
  -- `loan.collateralAmount` after the fee-on-transfer rejection
  -- guard (Codex round-6 P1 #4 on the design PR).
  maker_amount        TEXT    NOT NULL,
  taker_amount        TEXT    NOT NULL,

  -- Fusion auction deadline (Unix seconds). Past this point the
  -- borrower can call `cancelSwapToRepayIntent`; after `deadline +
  -- cfgIntentCancelGraceSeconds` the permissionless
  -- `cancelExpiredIntent` opens.
  deadline            INTEGER NOT NULL,

  -- Bookkeeping
  committed_at        INTEGER NOT NULL,
  committed_tx_hash   TEXT    NOT NULL,

  PRIMARY KEY (chain_id, loan_id)
);

-- Indexes
-- (1) Activity feed: "show me intents this borrower has committed"
-- queries hit `committed_by` + `chain_id` to honour the per-chain
-- viewing scope.
CREATE INDEX IF NOT EXISTS idx_swap_intents_committed_by
  ON swap_to_repay_intents (committed_by, chain_id);

-- (2) `orderHash → loan` reverse lookup mirrors the on-chain
-- `orderHashToLoanId` mapping — used by the agent worker when
-- Fusion's resolver callback returns the orderHash without the
-- loanId.
CREATE INDEX IF NOT EXISTS idx_swap_intents_order_hash
  ON swap_to_repay_intents (order_hash, chain_id);
