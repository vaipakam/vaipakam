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
`SetupTest`'s diamond was cutting 24 facets, while production cuts 36
(35 facets enumerated in `DiamondFacetNames.cutFacetNames()` plus
`DiamondCutFacet` installed via the diamond constructor). The four
facets the fold *needed* — `PrecloseFacet`, `RefinanceFacet`,
`EarlyWithdrawalFacet`, `PartialWithdrawalFacet` — were exactly the
ones every loan-mutation-past-creation test had to roll its own setUp
for. This release narrows that drift (24 → 28) using the same
strict-additive pattern the #173 work used to close the
`OfferMatchFacet` drift: every existing consumer keeps the same
diamond shape plus four newly-routed facets, and the pause-gating
regression guard's 9 previously-unreachable test cases
(`test_pause_precloseDirect`, `transferObligationViaOffer`,
`offsetWithNewOffer`, `completeOffset`, `refinanceLoan`,
`sellLoanViaBuyOffer`, `createLoanSaleOffer`, `completeLoanSale`,
`partialWithdrawCollateral`) now actually exercise the
`whenNotPaused` modifier they claim to guard. Closing this *specific*
drift was the load-bearing change for the fold — without it the
PauseGating fold would have hidden the same test-vs-prod blind spot
it was trying to remove.

The remaining 9-facet gap between `SetupTest` (28 routed) and
production (35 routed, 36 with the constructor's `DiamondCutFacet`) is
the same class of drift — `DiamondLoupeFacet`, `OwnershipFacet`,
`OracleAdminFacet`, `LegalFacet`, `VPFIDiscountFacet`,
`InteractionRewardsFacet`, `RewardAggregatorFacet`,
`RewardReporterFacet`, `StakingRewardsFacet` are all still unrouted
in the test diamond. Closing that gap is tracked as a separate
focused refactor in issue #229; doing it inside this PR would inflate
the scope from "fold two tests" to "rebuild SetupTest", and several of
those facets need post-init wiring (CCIP messenger mocks, channel
registration, role grants) that warrants its own verification pass.

Test results: every existing SetupTest consumer (34+ files, 2031 test
cases) stays green; PauseGatingTest 31/31 passing; KYC integration 6/6
passing; full non-invariant regression 2031/0/1 (the single skip is
the long-standing pre-Phase-1 sanctions case). No production code
touched in this PR — this is a test-suite refactor against the
ambient code surface.

Closes #168 (Track A subset). The remaining Track A candidates plus
the `OfferFacetTest` fold stay on the Issue under follow-up cards;
Track B (coverage redundancy audit) stays as filed.
