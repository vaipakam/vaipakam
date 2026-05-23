## SetupTest is now a strict superset of production (Issue #229)

PR #228 (#168 Track A subset) extended `SetupTest.t.sol`'s diamond cut from 24 → 28 facets so the `PauseGatingTest` fold could exercise selectors that production routes but the test diamond was silently missing. The fold surfaced a real test-vs-prod blind spot — 9 PauseGating cases had been silently asserting `FunctionDoesNotExist()` instead of `EnforcedPause()` because the test diamond didn't route the relevant facets. PR #228 closed four of those drift cases (`PrecloseFacet`, `RefinanceFacet`, `EarlyWithdrawalFacet`, `PartialWithdrawalFacet`); Codex reviewing that PR flagged the remaining 9-facet gap and filed this card to close it.

This release brings SetupTest's cut from 28 → 37 — matching every facet in `DiamondFacetNames.cutFacetNames()` plus `TestMutatorFacet` (intentionally retained on top of the production superset for the direct-write hooks invariant tests depend on). After this PR, SetupTest is a strict superset of production: every selector in the production diamond is reachable through SetupTest's `setupHelper()`, and a test that asserts `FunctionDoesNotExist()` against a production-routed selector now correctly fails.

The 9 newly-routed facets, slotted into `cuts[28..36]`:

- **`DiamondLoupeFacet`** — `facets()`, `facetAddress()`, `facetFunctionSelectors()` diamond-inspection surface.
- **`OwnershipFacet`** — ERC-173 ownership reads.
- **`OracleAdminFacet`** — the full 34-selector admin set (Chainlink registry / Tellor / API3 / DIA / Pyth / sequencer / Phase 3-4 peer-protocol and tier-reference-asset registries). Several test files previously did their own subset cut here; with the full set now routed by SetupTest, those local subsets become redundant and are stripped.
- **`LegalFacet`** — the 5-selector ToS-acceptance gate; sanctions oracle defaults to `address(0)` (fail-open per the retail-deploy policy in CLAUDE.md), so no post-init wiring is needed for tests.
- **`VPFIDiscountFacet`** — borrower-LIF discount surface; reads from shared storage with safe zero defaults.
- **`StakingRewardsFacet`** — VPFI staking surface.
- **`InteractionRewardsFacet`** — interaction-rewards reporting hooks.
- **`RewardAggregatorFacet`** — cross-chain reward aggregation.
- **`RewardReporterFacet`** — cross-chain reward REPORT/BROADCAST.

None of the 9 require post-init wiring; their state is either read on demand from shared storage with zero defaults that are valid for happy-path consumers, or admin-gated and accessible because the deployer already holds every role via `initializeAccessControl()` inside `setupHelper()`.

Two new selector-helper functions were added to `HelperTest.sol`: `getOracleAdminFacetSelectors()` (34 selectors, mirroring `_getOracleAdminSelectors` in `DeployDiamond.s.sol`) and `getLegalFacetSelectors()` (5 selectors, mirroring `_getLegalSelectors`). The other 7 selector helpers already existed in `HelperTest.sol` from earlier work; they just weren't being consumed by the SetupTest cut list.

Sixteen test files had previously done their own local `new XxxFacet()` + local `diamondCut(...)` block in `setUp()` precisely BECAUSE SetupTest's cut was missing those facets — each carried a comment along the lines of "SetupTest does not include it." With #229's superset closure, those local cuts would double-cut over SetupTest's pre-cut and revert (`LibDiamondCut: Can't add function that already exists`). All sixteen are de-duplicated in this release: the local declarations, constructions, and cut blocks are removed; the inherited SetupTest fields are used instead. The cleanup is uniform — every removed block carries a `// #229 — ...` comment pointing at the new home of the cut.

Full regression at **2046 / 0 / 0** (no skips this round), matching the pre-#229 baseline test count. The drift fix is structurally invisible to consumers — every existing test sees the same diamond shape it always saw, now with the production-mirror property the test scaffold should have had from the start.

Closes #229. The #168 Track A residual files (`OfferFacetTest`, `DepthTieredLtv`, `PerAssetPause`, `AccessControlTransferAdmin`) stay on #168 as deferred Track A candidates; #229 was the SetupTest-side gap only.
