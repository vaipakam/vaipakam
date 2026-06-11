## Thread — T-092-H: atomic accept-and-refinance — single-tx atomicity for refinance-tagged offers (#539)

Closes the multi-tx race-condition window between Tx 2 (accept, principal lands in borrower wallet) and Tx 3 (refinance, wallet drained to pay old loan). Pre-#539 the operational loan netting (PR #538) relied on a best-effort assumption that nothing would interfere between txs. This PR makes the netting structurally atomic: a refinance-tagged offer's accept now CHAINS into `RefinanceFacet.refinanceLoan` inside the same transaction.

### What's new

**Contract change in [`OfferAcceptFacet._acceptOffer`](contracts/src/facets/OfferAcceptFacet.sol)** — after the `OfferAccepted` event, when the accepted offer is a refinance-tagged Borrower offer (`refinanceTargetLoanId != 0`), chain into `RefinanceFacet.refinanceLoan` via the existing `LibFacet.crossFacetCall` pattern. Either both loans transition (old → Repaid, new → Active) or the whole tx reverts.

### Why no auth carve-out needed

`LibAuth.requireKeeperFor` already has the `msg.sender == address(this)` bypass built in ([LibAuth.sol:99](contracts/src/libraries/LibAuth.sol#L99) — "internal calls always allowed"). Cross-facet calls bypass the keeper auth check by design, so the chain works cleanly without any RefinanceFacet changes. The Phase 2a sanctions gate + kill-switch check inside `refinanceLoan` still fire on the current borrower-NFT owner exactly as on the standalone keeper-driven path.

### New error

`OfferAcceptFacet.AtomicRefinanceFailed` — surfaces when the chained refinance reverts. Distinct from generic accept errors so the dapp can render a refinance-specific copy ("the refinance check failed — caps tightened? sanctions list? grace expired?").

### Race-condition closure

Pre-#539, between accept and refinance, the borrower's wallet held the new principal exposed to:
- Competing dapp interactions (borrower's other approvals).
- MEV front-runs.
- Accidental borrower-side spends.

With this PR, that window is gone — the principal cycles in then out within the same tx.

### Verification

- forge build clean.
- `T092AutoLifecycleIntegrationTest` 18/18 (was 17, +1 selector existence guardrail for `AtomicRefinanceFailed`).
- `RefinanceFacetTest` 35/35.
- Deploy-sanity 12/12.

### Out of scope (follow-up)

- Full happy-path integration test (accept + chained refinance with real ERC20 allowances + new lender vault setup). The current `SetupTest` fixture doesn't carry the new-lender allowance/vault dance needed for this; expanding it is a separate PR. The selector existence guardrail catches the load-bearing structural invariant.
- Dapp surface for the new `AtomicRefinanceFailed` error i18n — add to `autoLifecycleErrors.ts` decoder + i18n strings.

### Pairs with

- **#538 (T-092-A)**: documents that operational netting works via wallet cycle; this PR makes that cycle atomic.
- **#532 (T-092-C)**: pre-grace notification still fires for loans that don't get matched at all (no offer accepted → no chain triggered).
- **#407 (Vault encumbrance sub-ledger)**: complements this — once free vs locked vault funds are distinguishable, true vault-first netting becomes safe alongside the atomic chain.

### Operator action

None — no migration, no new secret, no config knob. Pure contract change. Refinance-tagged offers created BEFORE this deploy carry `refinanceTargetLoanId != 0` and become atomic upon next accept. Refinance-tagged offers created AFTER also benefit.
