## Test scaffolding for `OfferMatchFacet` (Issue #173 — scaffolding piece)

The Range Orders Phase 1 matching surface — `OfferMatchFacet.matchOffers`
and `OfferMatchFacet.previewMatch` — had no targeted test file at all.
Coverage of the matcher came only via the integration scenarios that
touch `acceptOffer` end-to-end. The borrower-partial-fill PR (#102 →
#174) made the gap more load-bearing by adding new code paths
(borrower-side `amountFilled` increment, `collateralAmountFilled`
increment, dust-close + accept-flip, conditional refund, borrower
`amountMax = 0 → derive` fallback) that today's regression confirms
preserve the legacy single-fill path but never exercises the
partial-fill ON path.

This change ships the test-infrastructure half of #173:

- **SetupTest** now cuts `OfferMatchFacet` into its test diamond — a
  one-line drift fix. The production deploy already cuts it
  (DeployDiamond §5e), but SetupTest's diamond did not, which silently
  prevented any inheriting test from reaching `matchOffers` /
  `previewMatch` through the diamond fallback. No existing test calls
  these selectors, so the cut is a strict superset — every
  pre-existing test sees the same diamond shape it always did, plus
  two newly-reachable selectors.

- **`MatchOffersScaffoldTest.t.sol`** is a small reachability check:
  `previewMatch` returns a structured `MatchResult`, `matchOffers`
  reverts with a typed facet error (not a generic
  "selector-not-found"), and the partial-fill master kill-switch
  reverts `FunctionDisabled(3)` when off. Inheriting tests get the
  range + partial-fill flags pre-enabled via setUp.

The seven detailed scenarios from #173's scope (happy-path partial
fill, multi-fill consuming one borrower offer, dust-close, single-fill
fallback, borrower `amountMax = 0` derivation, advanced-mode override,
the `MatchError` revert paths) ride on this scaffolding and land as
a follow-up PR under the same issue.
