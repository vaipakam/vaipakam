## Test-scaffolding fold — PauseGatingTest + KYCTierEnforcementIntegration onto SetupTest (#168 Track A, subset)

The cold-cache `forge build` for this repo is 15-25 minutes and 8 GB RSS,
driven mostly by the viaIR + optimizer pipeline expanding every
diamond-cut helper a test file constructs. Issue #168 audited that
compile surface and called out a duplication pattern: a long tail of
test files each declare a private `_cut(...)` helper that re-stamps the
production facet list, and the resulting `setUp` is byte-for-byte a
slimmed copy of `SetupTest.setupHelper()`. Each file that folds onto
`SetupTest` drops that duplicated cut bytecode from its own compile
unit and shares the single `SetupTest` compilation with every other
fold sibling.

A per-file cut audit (recorded on the Issue) narrowed Track A to the
files where the absolute LOC drop actually moves the cold-build needle:
`PauseGatingTest.t.sol` (31 tests, was cutting 18 facets in its own
setUp) and `KYCTierEnforcementIntegration.t.sol` (6 tests, 11 facets).
This release ships both folds. The other Track A candidates
(`DepthTieredLtvTest`, `PerAssetPauseTest`,
`AccessControlTransferAdminTest`) were dropped from this subset because
their bespoke setUps either cut a small enough facet set that the fold
gain is marginal, or they install KYC / pause / access-control state
that conflicts with `SetupTest`'s post-init defaults in ways that
require more setUp-overrides than the fold removes. `OfferFacetTest`
(3.7 kLOC, 21 facets) is the biggest single win on the table but stays
its own focused PR — its bespoke setUp wires up enough special-purpose
test state that the safe fold needs its own session.

Folding `PauseGatingTest` surfaced a second, more interesting drift:
`SetupTest`'s diamond was cutting 24 facets, while production cuts 28
(per `DiamondFacetNames.cutFacetNames()` + `DeployDiamond.s.sol`). The
missing four — `PrecloseFacet`, `RefinanceFacet`,
`EarlyWithdrawalFacet`, `PartialWithdrawalFacet` — were exactly the
ones every loan-mutation-past-creation test had to roll its own setUp
for. This release closes that drift the same way the #173 work closed
the `OfferMatchFacet` drift: `SetupTest` is now a strict superset of
the production facet set, every existing consumer keeps the same
diamond shape plus four newly-routed facets, and the pause-gating
regression guard's 9 previously-unreachable test cases
(`test_pause_precloseDirect`, `transferObligationViaOffer`,
`offsetWithNewOffer`, `completeOffset`, `refinanceLoan`,
`sellLoanViaBuyOffer`, `createLoanSaleOffer`, `completeLoanSale`,
`partialWithdrawCollateral`) now actually exercise the
`whenNotPaused` modifier they claim to guard. Closing the drift is the
load-bearing change — without it the fold would have hidden the same
test-vs-prod blind spot it was trying to remove.

Test results: every existing SetupTest consumer (34+ files, 2031 test
cases) stays green; PauseGatingTest 31/31 passing; KYC integration 6/6
passing; full non-invariant regression 2031/0/1 (the single skip is
the long-standing pre-Phase-1 sanctions case). No production code
touched in this PR — this is a test-suite refactor against the
ambient code surface.

Closes #168 (Track A subset). The remaining Track A candidates plus
the `OfferFacetTest` fold stay on the Issue under follow-up cards;
Track B (coverage redundancy audit) stays as filed.
