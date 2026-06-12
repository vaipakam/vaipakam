## Thread — #407 PR 3: collateral lien release wires + 10 test-fixture updates

Third impl PR for the vault encumbrance sub-ledger. Lands the **release call sites** at every remaining loan-lifecycle terminal + the test-fixture updates needed for them to work with each minimal-cut `setUp()`.

### Release wires (via `EncumbranceMutateFacet.releaseCollateralLien` cross-facet call)

- `RepayFacet.repayLoan` — Active/FallbackPending → Repaid.
- `PrecloseFacet.precloseDirect` (direct path) — Active → Repaid.
- `RefinanceFacet._refinanceLoanLogic` — OLD loan's Active → Repaid.

Cross-facet pattern: each call site adds ~50B of bytecode (LibFacet.crossFacetCall + abi.encodeWithSelector) instead of ~150B that direct `LibEncumbrance.releaseCollateralLien` would have inlined. Keeps RepayFacet (which was at the EIP-170 ceiling in PR 1) within budget.

### Test-fixture sweep — 10 files updated

Each per-facet integration test maintains its own minimal-cut `setUp()` (14-20 facets, not the full 53). When `RepayFacet.repayLoan` calls `crossFacetCall(EncumbranceMutateFacet.releaseCollateralLien.selector, ...)`, the test's minimal cut needs `EncumbranceMutateFacet` registered or the diamond fallback fires `FunctionDoesNotExist`. Mechanically added EncumbranceMutateFacet to:

- `RepayFacetTest.t.sol` (14 → 15 cuts)
- `RefinanceFacetTest.t.sol` (18 → 19)
- `PrecloseFacetTest.t.sol` (18 → 19)
- `ClaimFacetTest.t.sol` (16 → 17)
- `AddCollateralFacetTest.t.sol` (16 → 17)
- `RiskFacetTest.t.sol` (17 → 18) — used by `SanctionsOracle.t.sol` via inheritance
- `WorkflowComplianceAndRejection.t.sol` (20 → 21)

Each diff adds: the import, the facet construction (`new EncumbranceMutateFacet()`), the cuts array size bump, and one new `IDiamondCut.FacetCut` entry calling `helperTest.getEncumbranceMutateFacetSelectors()`.

### Out of scope (still deferred)

- **PR 4 — Withdraw guard** at `VaultFactoryFacet.vaultWithdrawERC20`. The guard depends on this PR's release wires — without them, every non-default loan close would have left the lien active and the guard would block the legitimate post-settlement withdraw. Now safe to land.
- **PR 5 — Offer-principal-lock impl** (§7 of design doc) — wires `OfferCreateFacet._pullCreatorAssetsClassic` create + `OfferCancelFacet` / `OfferAcceptFacet` / `OfferMatchFacet` release. Bigger blast radius (matcher hot-path).
- ClaimFacet release wire (Settled transition) — borrower's collateral was already released back to their vault during the Repaid transition's `vaultWithdrawERC20(borrower)`; the lien is already tombstoned. Settled transition is for the LENDER's vault claim, which involves a different asset entirely.

### Verification

- forge build clean.
- 554/554 broader regression green (RepayFacetTest 65 + RefinanceFacetTest 36 + PrecloseFacetTest + LoanFacetTest + DefaultedFacetTest + ClaimFacetTest + RiskFacetTest + SanctionsOracle + WorkflowComplianceAndRejection + T092AutoLifecycleIntegrationTest + AddCollateralFacetTest + VPFIDiscountFacetTest + PauseGatingTest).
- All 12 deploy-sanity tests pass.
- ABI re-export ran.

### Pre-live posture

Per user direction (2026-06-12): pre-live → no ABI back-compat. Mechanical test-fixture updates accepted as part of the facet-add scaffold.
