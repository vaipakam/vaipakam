## Thread — T-092-H v2: atomic accept-and-refinance (#539)

Second attempt at #539. PR #542 was closed earlier today after Codex caught three blocking issues (P1 reentrancy nesting, P2 deferred-accept ordering, P3 misleading wrapper error). The [#549 design doc](docs/DesignsAndPlans/T092AtomicAcceptAndRefinance.md) specified the revised architecture; this PR implements it.

### Contract changes

#### `RefinanceFacet` — internal-callable variant

Existing `refinanceLoan(uint256, uint256) external nonReentrant whenNotPaused` is preserved as the external API for keeper EOAs + borrower-direct callers. The body has been extracted into a private `_refinanceLoanLogic`. A new `refinanceLoanFromAccept(uint256, uint256) external onlyDiamondInternal whenNotPaused` exposes the same logic to cross-facet callers without the `nonReentrant` guard — the outer `acceptOffer` / `matchOffers` `nonReentrant` lock covers the whole tx.

New error: `OnlyDiamondInternal` — fires when an external EOA tries to call `refinanceLoanFromAccept` directly. Mirrors the same shape used by `VaultFactoryFacet.onlyDiamondInternal`.

#### `OfferAcceptFacet._acceptOffer` — direct-path chain hook

After `offer.accepted = true` (inside the non-deferred `if (!deferAcceptFlip)` block at line 1010-1021), when the offer is a refinance-tagged Borrower offer, chain into `RefinanceFacet.refinanceLoanFromAccept` via `LibFacet.crossFacetCall`. The empty fallback selector (`bytes4(0)`) lets the inner revert payload bubble verbatim — the dapp's `autoLifecycleErrors.ts` decoder already handles the typed errors.

This branch covers:
- Direct `acceptOffer` calls.
- Direct `acceptOfferWithPermit` calls (same function body).
- `matchOffers` with `partialFillEnabled` OFF.

#### `OfferMatchFacet.matchOffers` — matched-path chain hook

In the borrower-side dust-close branch (after `bm.accepted = true` + `LibMetricsHooks.onOfferAccepted` + `OfferClosed` emit), when `bm.refinanceTargetLoanId != 0`, chain via the same `refinanceLoanFromAccept` selector. Closes the P2 gap that PR #542 had — the matched path with `partialFillEnabled` on now atomic-chains correctly.

#### Selector registry

Both `DeployDiamond.s.sol._getRefinanceSelectors()` and `HelperTest.getRefinanceFacetSelectors()` updated to include `refinanceLoanFromAccept` (2 selectors instead of 1).

### Tests

Two new tests in `T092AutoLifecycleIntegrationTest`:

- `test_T092H_AtomicAccept_DirectPath_ChainsInSameTx` — happy path. Builds an active loan, sets caps, creates a refinance-tagged offer, then a new lender (provisioned via the #548 helpers) accepts the offer with a single `acceptOffer` call. Asserts both loans transitioned: old → `Repaid`, new → `Active`. **Atomic guarantee verified end-to-end.**
- `test_T092H_RefinanceLoanFromAccept_RejectsExternalEOA` — structural guardrail. Asserts the `onlyDiamondInternal` modifier rejects direct external calls with `OnlyDiamondInternal` revert.

### Verification

- forge build clean.
- T092AutoLifecycleIntegrationTest 21/21 (was 19, +2 atomic-chain tests).
- Deploy-sanity 12/12 (selector registries updated; `SelectorCoverageTest` happy).
- RefinanceFacetTest 34/34, OfferFillModeTest + OfferMutateFacetTest broader 46/46 — no regression on the existing external entry.
- ABI re-export ran.

### Operator action

None. Pure contract change. The existing dapp surface (#523) sets `params.refinanceTargetLoanId` already; existing offers carrying the tag become atomic upon next accept.

### Pairs with

- **#530** — operational netting via wallet cycle is now structurally atomic (no multi-tx race window).
- **#532 + #545** — pre-grace warnings still relevant for loans where the matcher hasn't found a counterparty yet; the atomic chain only fires once a counterparty accepts.
- **#407** — vault encumbrance sub-ledger; once that lands, the refinance fund source can shift to vault-first without the locked-balance double-spend risk.
