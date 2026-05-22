## Canonical Limit-Order Phase 2 — implementation (Issue #183)

Implements the ratified design from PR #184 / [#183 design doc](../../DesignsAndPlans/CanonicalLimitOrderPhase2Design.md). Closes the `_acceptOffer` direct-accept deferral from PR #175 (the Codex P1×5 round-1 finding that forced a transitional revert) and removes the dead borrower `amountMax = 0` derivation path that #173's `test_borrowerAmountMaxZeroDerivation` SKIP was guarding.

### Contracts

- **`LibOfferMatch.sol`** — Deletes `_effBorrowerAmountMax`. `previewMatch` reads `B.amountMax` directly. The underflow guard before `borrowerRemaining = effBorrowerAmountMax - B.amountFilled` stays as defensive.
- **`OfferMatchFacet.sol`** — Deletes the post-match derivation branch in `matchOffers`. Removes now-unused `LibRiskMath` + `OracleFacet` imports.
- **`OfferCreateFacet.sol`** — Drops the create-time auto-collapse (`amountMax == 0 → amount`, same for rate + collateral). Adds typed invariant reverts (`AmountMustBePositive`, `AmountMaxMustBePositive`, `CollateralMustBePositive`, `CollateralAmountMaxMustBePositive`). Removes the now-dead range-flag kill-switch gates (`rangeAmountEnabled` / `rangeRateEnabled` / `rangeCollateralEnabled`) — under the canonical mapping every offer is structurally ranged. Retires the #169 SSTORE-skip optimisation for `collateralAmountMax`. Three carve-outs surfaced by running the swept regression:
  - Rate invariant allows `interestRateBpsMax == 0` (NFT rentals + no-interest loans).
  - Collateral `> 0` enforced only for ERC20+ERC20 loans (NFT collateral and NFT rentals exempt).
  - Lender sale-vehicle pattern (`collateralAmount == 0 == collateralAmountMax` both zero) explicitly allowed.
- **`LoanFacet.sol`** — `initiateLoan` direct-accept branch reads role-aware: lender offers → `loan.principal = offer.amountMax`, `loan.interestRateBps = offer.interestRateBps`; borrower offers → `loan.principal = offer.amount`, `loan.interestRateBps = offer.interestRateBpsMax`. `loan.collateralAmount = offer.collateralAmount` for both. matchOffers path unchanged (still reads `matchOverride.*`).
- **`OfferAcceptFacet.sol`** — Introduces `effectivePrincipal` local at the top of `_acceptOffer` resolving three-way (matchOverride.amount when active / amountMax for lender direct-accept / amount for borrower direct-accept). Replaces the ERC20-path LIF math, principal transfer, `OfferAccepted` event payload, and KYC value calc to use it. The KYC change is load-bearing — gates on the real loan value at risk under Phase 2 (a lender direct-accept on a $10k offer was previously calling KYC at $1k = 10% minPartialFill under the new schema). Adds `_refundBorrowerCollateralResidualIfNeeded` private helper that fires on direct-accept of a borrower offer with `collateralAmountMax > collateralAmount` (PR #184 Codex P1.2 — without this the residual collateral would be stranded; matchOffers' dust-close branch doesn't fire on the direct-accept path). Extracted to a helper because the inline block pushed `_acceptOffer` over viaIR's stack budget.

### Tests

- **31 existing test files** swept via a mechanical Python script (`/tmp/sweep_amountmax_zero.py`). 534 fields updated. Every `CreateOfferParams` struct that shipped `amountMax: 0` / `interestRateBpsMax: 0` / `collateralAmountMax: 0` (Phase 1 auto-collapse pattern) now ships the corresponding base value. Single-value offer semantic stays byte-identical to today's behaviour.
- **`BorrowerPartialFillTest.t.sol`** — `test_borrowerAmountMaxZeroDerivation` SKIP doc-comment updated from "Phase 2 prereq, unblock later" to **permanent skip** (the derivation path was rejected as a design direction; the test stays as a future-proofing assertion that the path remains deleted).
- **Full regression** (`forge test --no-match-path "test/invariants/*"`): **2021 PASS, 0 FAIL, 6 SKIP** across 99 test suites.

### Frontend

- **`apps/defi/src/lib/offerSchema.ts`** — `toCreateOfferPayload` now ships canonical role-asymmetric values. Lender: `amount = max(1, lendingAmount × 10/100)`, `amountMax = lendingAmount`, `interestRateBps = user rate`, `interestRateBpsMax = MAX_INTEREST_BPS`. Borrower: `amount = lendingAmount` (the floor), `amountMax = lendingAmount`, `interestRateBps = 0`, `interestRateBpsMax = user rate`. NFT-rental offers stay single-value on amount.
- **`apps/defi/src/pages/OfferBook.tsx`** — Offer table reads role-aware fields: lender Principal `amountMax`, lender Rate `interestRateBps`, borrower Principal `amount`, borrower Rate `interestRateBpsMax`. Anchor-rate delta annotation switches to the role-aware rate. Adds `amountMax`, `interestRateBpsMax`, `collateralAmountMax` to `OfferData` and `RawOffer` types with fallback-to-floor for legacy indexer rows.
- **`useMyOffers.ts`** + **`offerSnapshot.ts`** — Cancelled-offer reconstruction paths populate the new `*Max` fields; localStorage snapshot loader falls back to floor fields for pre-Phase-2 snapshots.

### ABI export

- Per-facet ABI JSONs regenerated. Only diff is `OfferCreateFacet.json` (four new typed errors). Frontend + Worker typechecks all clean (`@vaipakam/defi`, `@vaipakam/keeper`, `@vaipakam/indexer`, `@vaipakam/agent`).

### Out of scope for this PR (follow-up cards)

- Cumulative-depth column on the offer table (design §6.5, deferred to Phase 2.5).
- Borrower row collateral split into "Committed (floor) + Available (unfilled)" — Phase 2 frontend ships single-value borrower offers.
- Borrower row showing derived `amountMax` as range `$min–$max` — same reason.
- OfferDetails deep-dive page additional fields (§6.4).
- Two new dedicated test files (`RoleAwareAcceptOfferTest.t.sol`, `CreateOfferInvariantsTest.t.sol`) — surfaced for follow-up; the swept existing tests + the full regression cover the role-aware reads end-to-end via integration paths.

### Migration

Platform is prelive. Fresh testnet redeploy on next cycle. No legacy storage migration path needed.
