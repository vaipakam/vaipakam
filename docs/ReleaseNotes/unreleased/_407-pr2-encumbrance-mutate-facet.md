## Thread — #407 PR 2: EncumbranceMutateFacet foundation

Second impl PR in the vault encumbrance sub-ledger sequence. Lands the **`EncumbranceMutateFacet`** — a thin cross-facet entry that exposes `releaseCollateralLien(uint256)` so each loan-lifecycle terminal can release the lien via `LibFacet.crossFacetCall` (~50 bytes per call site) instead of inlining `LibEncumbrance.releaseCollateralLien` directly (~150 bytes per call site).

### What's new

- **`contracts/src/facets/EncumbranceMutateFacet.sol`** — new facet, `onlyDiamondInternal` gate, single selector today (`releaseCollateralLien`). Will grow with the offer-principal-lock impl PR.
- **Full 7-site facet-registration**:
  - `DiamondFacetNames.cutFacetNames()` → 52 entries (was 51); appended `"EncumbranceMutateFacet"`.
  - `DeployDiamond.s.sol` → import + construct + cut at `cuts[51]` + `_getEncumbranceMutateFacetSelectors()` helper + `Deployments.writeFacet`.
  - `HelperTest.sol` → mirror import + facet var + `getEncumbranceMutateFacetSelectors()` helper.
  - `SetupTest.t.sol` → import + facet var + construct + cuts[52] wire (was 52 entries; now 53 with the test-only `TestMutatorFacet`).
  - `SelectorCoverageTest.t.sol` → `_addAll(_getEncumbranceMutateFacetSelectors())`.
  - `FacetSizeLimitTest.t.sol` + `SelectorCoverageTest.t.sol` + `DeployDiamondIntegrationTest.t.sol` → `string[51]` → `string[52]` for `cutFacetNames()` returns.

### Why the release wires are NOT in this PR

The 9 per-facet integration tests (`RepayFacetTest`, `RefinanceFacetTest`, `PrecloseFacetTest`, `ClaimFacetTest`, etc.) each maintain their own minimal-cut `setUp()` (typically 14-20 facets, not all 52). When `RepayFacet.repayLoan` calls `crossFacetCall(EncumbranceMutateFacet.releaseCollateralLien.selector, ...)`, those tests' minimal cuts don't include `EncumbranceMutateFacet` → the diamond fallback fires `FunctionDoesNotExist`.

Updating all 9 test-fixture cut blocks (add facet construction + array-size bump + cut entry per file) is a focused mechanical change that warrants its own scoped PR (PR 3). This PR delivers the **facet foundation + registration** so PR 3 can drop in the release call sites + fixture updates without bouncing between concerns.

### Tradeoffs

- **What this PR enables**: any future code (offer-principal-lock impl, withdraw guard, third-party integrations) can now `crossFacetCall` to release a collateral lien with one stable selector.
- **What's still deferred to PR 3**: the actual release call sites at `RepayFacet.repayLoan` / `PrecloseFacet.precloseDirect` / `RefinanceFacet._refinanceLoanLogic` / `ClaimFacet.claimAs*` — alongside the matching 9 test-fixture updates.

### Verification

- forge build clean.
- All 12 deploy-sanity tests pass (DiamondFacetNames + FacetSizeLimitTest + SelectorCoverageTest + DeployDiamondIntegrationTest).
- 277/277 broader regression (RepayFacetTest 65 + RefinanceFacetTest 36 + PrecloseFacetTest + LoanFacetTest + DefaultedFacetTest + T092AutoLifecycleIntegrationTest 22) — no regressions.
- ABI re-export ran.

### Pre-live posture

Per user direction (2026-06-12): pre-live → no ABI back-compat. The new facet + selector cut is an accepted facet-refresh cost.

### Out of scope (PR 3+)

- Release wires at `RepayFacet.repayLoan` / `PrecloseFacet.precloseDirect` / `RefinanceFacet._refinanceLoanLogic` / `ClaimFacet.claimAs*` (cross-facet calls).
- 9 per-facet test-fixture updates to include `EncumbranceMutateFacet` in their minimal cuts.
- Withdraw guard at `VaultFactoryFacet.vaultWithdrawERC20`.
- Offer-principal-lock impl (§7 of design doc).
