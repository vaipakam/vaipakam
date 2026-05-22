## Dedicated coverage for OfferAcceptFacet.acceptOffer against ranged offers (Issue #191)

PR #187 (canonical limit-order Phase 2) introduced role-aware reads in
the direct-accept path: when a borrower accepts a lender's ranged
offer, the resulting loan picks the lender's `amountMax` as principal
and the lender's `interestRateBps` (their floor) as the rate — the
most favourable for the borrower. When a lender accepts a borrower's
ranged offer, the symmetric resolution applies: principal =
borrower's `amount` (their floor), rate = borrower's
`interestRateBpsMax` (their ceiling) — the most favourable for the
lender.

Phase 2's matchOffers / partial-fill plumbing had dedicated test
coverage (`BorrowerPartialFillTest`, `MatchOffersScaffoldTest`,
`CancelAfterPartialFillTest`). The direct-accept path against ranged
offers did not. Every `testAccept*` in the existing OfferFacetTest
sweep used `amountMax == amount` and `interestRateBpsMax ==
interestRateBps`, so the role-aware code paths were mechanically
taken but never exercised with a non-trivial range — a regression
that swapped read fields would have slipped past every test.

This adds `contracts/test/AcceptRangedOfferTest.t.sol` with six
focused scenarios filling that gap:

1. **Lender-posted ranged offer + borrower-acceptor** pins the role-
   aware resolution: loan principal equals the lender's `amountMax`
   (10k of a `[1k, 10k]` range) and the rate equals the lender's
   floor (300 bps of a `[300, 800]` range). The lender's escrow is
   fully drained of the 10k pre-funded at create time, and the
   borrower wallet receives the principal net of the 0.1% loan
   initiation fee.

2. **Borrower-posted ranged offer + lender-acceptor** pins the
   symmetric resolution: loan principal equals the borrower's
   `amount` (the 1k floor) and the rate equals the borrower's ceiling
   (800 bps). The lender's wallet is debited by the matched principal
   that the acceptOffer path pulls into the lender's escrow at accept
   time.

3. **Residual collateral refund on direct-accept** verifies that
   `_refundBorrowerCollateralResidualIfNeeded` fires on the direct-
   accept path, not only on matchOffers. With `collateralAmount = 500`
   and `collateralAmountMax = 5_000`, the borrower has 5k pre-
   escrowed at create time; after the lender's accept, the loan
   locks only the 500 floor and the borrower's wallet receives the
   4_500 unused collateral back.

4. **No-residual case** asserts the helper short-circuits cleanly
   when `collateralAmount == collateralAmountMax` (no extra escrow
   withdraw attempted).

5. **Cancel after direct-accept reverts** locks in the terminal-state
   guarantee: Phase 2 direct-accept is single-fill, so subsequent
   `cancelOffer` reverts `OfferAlreadyAccepted`. Symmetric to
   `CancelAfterPartialFillTest`'s dust-close terminal case, but for
   the direct-accept terminal state.

6. **Single-value offer regression sentinel** keeps the trivial
   `amount == amountMax` case under direct test, so a regression on
   the trivial path lights up alongside the range-aware ones.

The test file also documents an implementation invariant worth
recording: **direct-accept does NOT update `offer.amountFilled`**.
The terminal state is signalled via `offer.accepted = true`; the
effective fill surfaces through the OfferAccepted event payload, not
the storage field. `amountFilled` is exclusively the matchOffers
accumulator (per OfferAcceptFacet line 963 comment, "Phase 1
acceptOffer is single-fill").

Out of scope for this file (tracked separately): NFT-collateral /
NFT-rental partial-fill shapes, sanctions tier on ranged offers
(covered by `SanctionsOracle.t.sol`), and multi-fill matchOffers
(covered by `BorrowerPartialFillTest`).

Closes #191.
