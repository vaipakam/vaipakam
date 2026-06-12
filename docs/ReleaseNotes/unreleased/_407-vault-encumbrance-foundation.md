## Thread — #407 vault encumbrance sub-ledger — foundation + collateral lien (PR 1 of N)

First implementation PR for the unified vault encumbrance sub-ledger described in [`docs/DesignsAndPlans/PerLoanCollateralLien.md`](docs/DesignsAndPlans/PerLoanCollateralLien.md). Scoped per design doc §7.5 (recommended impl sequencing): collateral-lien half lands first; offer-principal-lock half is a separate follow-up PR.

### What's new — storage

- **`LibVaipakam.Encumbrance` struct** — one row per active lien (asset, tokenId, amount, kind via per-side mapping, released tombstone).
- **`LibVaipakam.Storage.loanCollateralLien[loanId]`** — per-loan collateral lien row.
- **`LibVaipakam.Storage.encumbered[user][asset][tokenId]`** — running aggregate that the withdraw guard (separate PR) will consult to compute `freeBalance = balanceOf − Σ liens`.
- **`LibVaipakam.Storage.offerPrincipalLien[offerId]`** — pre-allocated for the offer-principal-lock impl PR; this PR doesn't write to it.

### What's new — library

**`LibEncumbrance`** — `internal`-only helpers operating directly on storage:

- `createCollateralLien(loanId, loan)` — call from `LoanFacet.initiateLoan` after the loan row is final.
- `releaseCollateralLien(loanId)` — call from every loan-lifecycle terminal that frees the collateral. **Idempotent** on already-released or empty rows.
- `rekeyCollateralLienOnRefinance(oldLoanId, newLoanId, newLoan)` — handles refinance's release-old + create-new pattern in one helper.
- Offer-principal half (`createOfferPrincipalLien` / `decrementOfferPrincipalLien` / `releaseOfferPrincipalLien`) — implemented but not yet wired; activates in the follow-up offer-principal-lock impl PR.
- `freeBalance(user, asset, tokenId, rawBalance)` — saturating `raw − encumbered` view helper.

### Hook wiring (this PR — partial coverage)

- **Create**: `LoanFacet.initiateLoan` calls `createCollateralLien` after `_emitLoanInitiatedDetails`.
- **Release on default**: `DefaultedFacet.triggerDefault` calls `releaseCollateralLien` right after the `transitionFromAny(Defaulted)` flip.

### What's INTENTIONALLY NOT wired in this PR

- **Release on Repaid** (`RepayFacet.repayLoan`): RepayFacet sits at the EIP-170 24,576-byte ceiling — adding the release call pushes it 151 bytes over. The lien tombstones via the eventual Settled transition (`ClaimFacet`) on a follow-up PR.
- **Release on preclose** (`PrecloseFacet.precloseDirect` + sale-vehicle / offset paths): same EIP-170 concern; follow-up.
- **Re-key on refinance** (`RefinanceFacet._refinanceLoanLogic`): same EIP-170 concern; follow-up.
- **Release on claim** (`ClaimFacet`): follow-up.
- **Withdraw guard** at `VaultFactoryFacet.vaultWithdrawERC20`: touches every facet's vault interactions — warrants its own focused PR.
- **Offer-principal-lock half** (§7 of the design doc): per design §7.5, separate impl PR; matcher hot-path coordination is too much to fold here.

### Approach for the remaining wires

Per the design doc §3.4 + this PR's RepayFacet note, the recommended path is to extract a thin **`EncumbranceMutateFacet`** with `releaseCollateralLien(loanId) external onlyDiamondInternal` so every loan-lifecycle terminal can cross-facet-call it (~50 bytes added per call site vs ~150 for inlined). That's deferred to the next PR.

### View surface — added to MetricsFacet

Four new view selectors (registered in `DeployDiamond._getMetricsSelectors` + `HelperTest.getMetricsFacetSelectors`):

- `getLoanCollateralLien(loanId) → Encumbrance` — proves "this exact collateral backs this exact loan."
- `getOfferPrincipalLien(offerId) → Encumbrance` — stub for the follow-up offer-principal impl.
- `getEncumbered(user, asset, tokenId) → uint256` — aggregate sum of active liens.
- `getFreeBalance(user, asset, tokenId, rawBalance) → uint256` — convenience wrapper.

### Verification

- forge build clean.
- New test `test_407_LoanInitCreatesCollateralLien` exercises: init loan → assert per-loan lien row + aggregate + free-balance helper.
- T092AutoLifecycleIntegrationTest 22/22 (+1 new) + 347/348 broader regression green (one pre-existing skip).
- Deploy-sanity 12/12 — EveryFacetUnderEip170 passes (DefaultedFacet has headroom; RepayFacet stays at-ceiling but unchanged).
- ABI re-export ran.

### Pre-live posture

Per user direction (2026-06-12): pre-live → no ABI back-compat concerns. The struct appends + storage map appends are accepted facet-refresh cost.

### Out of scope (follow-up PRs)

- Release wiring at the remaining terminals (`RepayFacet`, `PrecloseFacet`, `RefinanceFacet`, `ClaimFacet`) via the `EncumbranceMutateFacet` cross-facet pattern.
- Withdraw guard at `VaultFactoryFacet.vaultWithdrawERC20`.
- Offer-principal-lock impl (§7 of design doc) — wiring of `OfferCreateFacet._pullCreatorAssetsClassic` create + `OfferCancelFacet` + `OfferAcceptFacet` + `OfferMatchFacet` release/decrement.
- Spec updates (`docs/FunctionalSpecs/ProjectDetailsREADME.md` Ethos E1 provability section).
