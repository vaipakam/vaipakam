## Thread — T-092 Phase 2b: refinance-target caps enforced at offer-create + offer-accept (#506)

Phase 2b of T-092 (#499). Closes the architectural timing hole Codex flagged on PR #504 (Phase 2's first attempt): cap enforcement at `RefinanceFacet.refinanceLoan` was too late because the replacement loan already existed before the keeper could fail the cap check. Caps now bind at the OFFER ACCEPT step — before any new loan is created.

### What's new

**New `Offer` + `CreateOfferParams` field — `uint256 refinanceTargetLoanId`:**
- Default `0` → standard borrower offer (no refinance intent), behavior identical to pre-Phase 2b.
- Non-zero → this Borrower offer is created with the intent to refinance the targeted loanId. The cap-check fires automatically at both create and accept time.

**New shared library — `LibAutoRefinanceCheck`:**
A single `validate(s, loanId, offerCreator, offerMaxRate, offerDurationDays)` helper used by BOTH `OfferCreateFacet.createOffer` AND `OfferAcceptFacet._acceptOffer`. The validator:

1. Verifies the targeted loan is Active.
2. Verifies the offer creator is the current borrower-NFT owner (catches stale offers when the NFT transferred between create and accept).
3. Verifies `autoRefinanceCaps[loanId].enabled` AND the caps were set by the current NFT owner (staleness fence — the new owner must explicitly re-set caps).
4. Verifies `offerMaxRate ≤ caps.maxRateBps`.
5. Verifies the worst-case end time (block.timestamp + durationDays × 1 day) ≤ caps.maxNewExpiry.

**Five new errors on `LibAutoRefinanceCheck`:**
- `RefinanceTargetNotActive` — targeted loan not Active.
- `RefinanceTargetNotBorrower` — offer creator isn't the current borrower-NFT owner.
- `RefinanceCapsRequired` — caps disabled or stale.
- `RefinanceRateExceedsCap` — new offer's rate exceeds the cap.
- `RefinanceExpiryExceedsCap` — new loan's end time exceeds the cap.

**One new error on `OfferCreateFacet`:**
- `InvalidRefinanceTarget` — `refinanceTargetLoanId != 0` on a non-Borrower offer.

### Why a shared library

The cap validation is identical at create + accept time but lives in two different facets. Inlining the storage reads + comparisons at each site would push OfferAcceptFacet over the EIP-170 bytecode limit (it's already a high-occupancy facet). The library approach keeps both facets lean — each only emits the function call.

### What this fixes vs. the closed PR #504

The Phase 2 first attempt enforced caps at `RefinanceFacet.refinanceLoan` time. But by then:
1. Borrower offer was created (separate tx).
2. Lender accepted (separate tx) — new loan EXISTED with terms above the cap; new principal flowed to the borrower's vault.
3. refinanceLoan reverted on cap-check — borrower stayed obligated to the new lender at out-of-cap terms.

This PR moves the check to step 2 (and step 1) so the new lender never accepts an offer whose terms violate the borrower's caps in the first place. Borrower-direct refinances (where `msg.sender == currentBorrowerNftOwner`) still work without caps — the borrower is acting in their own interest.

### Storage layout

- `Offer.refinanceTargetLoanId` (uint256) — append-only at slot 22 of the Offer struct, after `parallelSaleOrderHash`. Existing offers stay zero (= standard); new offers can opt in.
- `CreateOfferParams.refinanceTargetLoanId` (uint256) — append-only at the tail. All 48 test + script + production sites updated to supply `refinanceTargetLoanId: 0` in their named-arg constructions.

### Verification

- `forge build` clean.
- AutoLifecycleFacetTest 13/13 (added LibAutoRefinanceCheck selector guardrail).
- ProfileFacetTest 50/50 + RefinanceFacetTest 34/34 + OfferFillModeTest + OfferMutateFacetTest green (107/107 broader regression).
- Deploy-sanity 12/12.

### Operator action

None for the contract change — the field defaults to zero so legacy flows are bit-for-bit unchanged. The dapp's keeper-driven auto-refinance UX must:
1. Set `params.refinanceTargetLoanId` to the loan being refinanced when constructing the borrower offer.
2. Surface the cap-check revert messages to the user.

The keeper-bot integration test alongside Phase 2a's PR landing will exercise the full keeper-driven loop (create refinance-tagged offer → new lender accepts → refinanceLoan completes), validating that the cap check binds at accept and the refinance close-out behaves correctly.
