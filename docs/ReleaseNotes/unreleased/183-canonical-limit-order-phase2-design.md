## Canonical Limit-Order Phase 2 — design doc (Issue #183)

Ships `docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md`, the
ratified design for the second phase of the canonical limit-order arc.
The doc captures every decision locked in the multi-round design pass:

- **Frontend single-input-per-role mapping** — lender enters one
  value per dimension (lendingAmount + collateralAmount + rate +
  optional minPartialFillAmount); borrower does the same. No
  Basic/Advanced range UI.
- **Role-aware `_acceptOffer` reads** — direct-accept reads
  `amountMax` for lender offers / `amount` for borrower offers;
  `interestRateBps` for lender / `interestRateBpsMax` for borrower;
  `collateralAmount` for both. Closes the PR #175 Codex P1 vector
  (lender shipping `amount = 1 wei` → 1-wei direct-accept transfer)
  without adding a new selector.
- **Invariant: `amountMax >= amount > 0`** — drop the create-time
  auto-collapse; new typed reverts; storage always holds explicit
  non-zero values.
- **Delete `_effBorrowerAmountMax`** — the GTC derivation in
  LibOfferMatch becomes dead code under the new invariant. The
  `test_borrowerAmountMaxZeroDerivation` SKIP from #173 becomes a
  permanent skip with updated reasoning.
- **`minPartialFillAmount`** — replaces the implicit `amount` floor
  for lender offers; default 10% of `lendingAmount`.
- **Display side extends existing OfferBook** — the DEX-style
  anchor-in-middle two-sided layout is already there; Phase 2
  retunes columns (new cumulative-depth column; borrower side gets
  split collateral display and an explicit `$min–$max` range).
- **Migration**: prelive; fresh testnet redeploy.

The doc covers context, the model, direct-accept semantics, matchOffers
semantics, the dropped derivation, display side, migration, full
implementation plan (files + estimated LOC), risk register, and a
decision log of every choice made during the session.

Implementation rides on this doc — separate PR after the design lands.
