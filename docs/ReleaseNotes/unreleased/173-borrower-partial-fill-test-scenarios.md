## Seven-scenario coverage for borrower partial-fill matching (#173 follow-up)

The scaffolding PR (#178) closed the SetupTest cut drift and shipped
three smoke tests for `OfferMatchFacet.matchOffers` / `previewMatch`.
This PR adds the seven concrete scenarios the issue's body scopes,
landing as `contracts/test/BorrowerPartialFillTest.t.sol`.

### What's covered

- **Happy-path partial fill** — first match on a wide borrower range:
  `B.amountFilled` tracks the match, the clamp-up collateral pick
  resolves to `max(lender_required, B.collateralAmount)`, the
  borrower offer stays OPEN, and collateral STAYS in escrow custody
  across the match.
- **Multi-fill draining a borrower offer + dust-close** — three
  lenders consume a `[1_000, 10_000]` borrower in sequence; the
  third match's `borrowerRemaining < B.amount` triggers dust-close;
  `B.accepted` flips to true and the residual collateral
  (`collateralAmountMax - collateralAmountFilled`) refunds to the
  borrower's wallet in the same tx.
- **Single-fill fallback when the kill-switch is off** — flipping
  `partialFillEnabled` back off makes `matchOffers` revert
  `FunctionDisabled(3)` as the outer gate. The wallet-balance check
  confirms a reverted call moves no funds.
- **Borrower advanced-mode override** — `amountMax` ships as a
  literal (8_000), the storage holds it verbatim, and a 7_000-amount
  lender matches against it.
- **Borrower `amountMax = 0` derivation** — **documented skip**: the
  derivation in `LibOfferMatch._effBorrowerAmountMax` is forward-
  looking code for #165 Phase 2. Today's `createOffer` auto-collapses
  `params.amountMax = 0 → params.amount` before SSTORE, so storage
  never holds 0 and the derivation never fires through the public
  interface. The test skips with a clear reason; the assertion gets
  written for real when Phase 2 makes the path reachable.
- **MatchError revert paths** — two scenarios cover the typed
  reverts: `AmountNoOverlap` (lender amount sits outside the
  borrower's range) and `RateNoOverlap` (borrower's rate ceiling
  below the lender's rate floor). Both assert that `previewMatch`
  surfaces the structured `MatchError` AND that `matchOffers` maps
  it to the typed facet revert.

### Status

- 7 tests authored: **6 PASS + 1 documented SKIP**.
- Card #173 covers the test infrastructure end-to-end with this PR;
  the skip resolves when #165 Phase 2 lands and the borrower GTC
  storage flow keeps `amountMax = 0` rather than auto-collapsing.
