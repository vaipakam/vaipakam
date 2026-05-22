## Dedicated coverage for offer cancellation after partial fill (Issue #188)

`OfferCancelFacet.cancelOffer` already implements correct partial-fill
cancellation behaviour (the math + the Codex P0 fix from #102 round-1
that subtracts `collateralAmountFilled` on the borrower side), but the
behaviour had zero dedicated test coverage. A future refactor could
silently break the refund math and regression wouldn't catch it.

This adds `contracts/test/CancelAfterPartialFillTest.t.sol` with four
focused scenarios:

1. **Lender partial-fill then cancel** — lender posts `[1k, 10k]`,
   one matchOffers consumes 5k, lender cancels. Assert refund =
   `amountMax - amountFilled = 5k`, loan from the prior match
   unaffected, `offer.accepted = true` post-cancel, cancel cooldown
   bypassed.

2. **Borrower partial-fill then cancel** — borrower posts `[1k, 10k]`
   lending with collateral range `[500, 5_000]`, one match consumes
   5k principal + 500 collateral, borrower cancels. Assert refund =
   `collateralAmountMax - collateralAmountFilled = 4_500`. Pins the
   Codex P0 fix from #102 round-1 — without the subtraction, the
   borrower would withdraw the 500 backing the live loan
   (fund-lock for the lender's claim).

3. **Cancel cooldown bypassed when amountFilled > 0** — partially-
   filled lender offer cancels successfully WITHIN the
   `MIN_OFFER_CANCEL_DELAY` window (no `vm.warp` past the delay).
   Verifies the `OfferCancelFacet` line ~112-118 bypass: the
   anti-front-run cooldown applies to never-matched offers only.

4. **Cancel after dust-close terminus reverts** — three matchOffers
   drain a borrower offer to dust (`borrowerRemaining < B.amount`),
   `OfferMatchFacet` flips `accepted = true`. Subsequent `cancelOffer`
   reverts `OfferAlreadyAccepted` per the design's terminal-state
   guarantee.

Implementation is unchanged; this is pure test coverage. Each test
exercises the refund formula directly via assertions on the wallet
balance delta + the loan's collateral / principal staying intact.

Coverage extends symmetrically across BOTH lender and borrower sides
of the partial-fill cancel surface. The four scenarios exercise the
ERC20-on-both-legs shape — the same shape that drives the bulk of
matchOffers traffic and the shape the #102 round-1 P0 fix targeted.
NFT-collateral and NFT-rental loan shapes are not exercised in this
file; the `OfferCancelFacet` code paths for those shapes are still
indirectly covered by other test files. (A dedicated harness for
NFT-shape partial-fill cancellation, if those configurations end up
in the partial-fill regime under the final invariants, would be a
separate follow-up — `OfferCreateFacet` does not currently enforce
an ERC20-only guard on ranged `amountMax`, so the structural
invariants alone don't rule that combination out.)
