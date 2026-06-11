## Thread — T-092 Phase 2a: refinance fund-routing + borrower sanctions + auto-lifecycle kill switches (#505, #508)

Phase 2a of T-092 (#499). This PR ships two related fixes the Phase 2 first-attempt review (#504, closed) and the user's follow-up question surfaced.

### Bug fix — RefinanceFacet fund-routing on the keeper-driven path

The `KEEPER_ACTION_REFINANCE` keeper authorization landed long ago in Phase 6, but `RefinanceFacet.refinanceLoan` still treated `msg.sender` as the borrower throughout the fund-flow code. On the keeper-driven path, msg.sender is the KEEPER — so:

- The treasury-fee `safeTransferFrom(msg.sender, ...)` would debit the KEEPER's wallet, not the borrower's.
- The lender's `vaultDepositERC20From(msg.sender, ...)` would pull from the KEEPER.
- The old collateral `vaultWithdrawERC20(msg.sender, ...)` would source from the KEEPER's vault and route TO the keeper — leaving the borrower's collateral stranded.

Fixed by resolving `currentBorrowerNftOwner = LibERC721.ownerOf(oldLoan.borrowerTokenId)` once at the top of `refinanceLoan` and threading it through every fund-flow site (treasury fee, lender deposit, ERC20/ERC721/ERC1155 collateral release). The borrower's wallet allowance for the principal asset is still the source-of-funds — keeper-driven invocations need the borrower to have pre-approved the diamond, which is the standard refinance prerequisite the dapp surfaces. The `offer.creator` check is also updated to bind against the NFT owner rather than msg.sender, so a keeper can complete refinance when the borrower (NFT owner) created the offer.

### Bug fix — borrower-NFT-owner sanctions check on keeper refinance

The previous code only sanctions-checked `msg.sender`. A sanctioned borrower could use an unsanctioned keeper to complete refinance — bypassing OFAC screening on the actual fund-receiving wallet. Added `_assertNotSanctioned(currentBorrowerNftOwner)` on the keeper path.

### New feature — three admin kill switches for auto-lifecycle (#508)

Phase 1 + Phase 3 shipped the auto-lifecycle surface with per-user / per-loan consent flags but NO admin (or future governance) controlled circuit breaker. If a keeper-path bug surfaces post-deploy, the only mitigations today are per-user revocation (slow + per-account) or pausing the entire diamond (over-broad). Added three new bool fields in `ProtocolConfig`:

- `cfgAutoLendEnabled` — controls whether `setAutoLendConsent(true)` succeeds. Users can still revoke (set to `false`) even when the feature is disabled.
- `cfgAutoRefinanceEnabled` — controls the keeper-driven path of `refinanceLoan`. Borrower-direct refinance still works (the borrower acts in their own interest).
- `cfgAutoExtendEnabled` — controls the entire `extendLoanInPlace` entry point (both keeper-driven and borrower-direct, because the executor IS the only entry).

Setters live on `AdminFacet` (not ConfigFacet — ConfigFacet's runtime bytecode is already near the EIP-170 24,576-byte ceiling): `setAutoLendEnabled(bool)`, `setAutoRefinanceEnabled(bool)`, `setAutoExtendEnabled(bool)`. All `ADMIN_ROLE`-gated; migration to the `TimelockController` happens on the standard governance handover path.

All three default `false` on a fresh deploy — admin flips on post-testnet-bake. Same conservative posture as the existing `rangeAmountEnabled` / `cfgKeeperRewardEnabled` flags.

### What's NOT in this PR

Phase 2b (#506) — moving `autoRefinanceCaps` enforcement to `OfferAcceptFacet.acceptOffer` so caps bind BEFORE the replacement loan is created. That's the architectural change Codex's original Phase 2 review surfaced; it lives on its own PR because OfferAcceptFacet is a high-traffic audit-priority surface.

### Verification

- `forge build` clean.
- `AutoLifecycleFacetTest` 12/12 green (added kill-switch tests).
- `ProfileFacetTest` 50/50 + `RefinanceFacetTest` 34/34 green.
- Deploy-sanity 12/12.
- ABI re-export clean.

### Operator action

- Post-deploy, admin must call `setAutoLendEnabled(true)`, `setAutoRefinanceEnabled(true)`, and `setAutoExtendEnabled(true)` to enable the auto-lifecycle features. Documented in `DeploymentRunbook.md` (separate doc PR).
- Existing borrower wallets that wired keeper-driven refinance off-chain need to ensure their wallet's ERC20 approval to the diamond covers `oldLoan.principalAsset`. The dapp surfaces this in the keeper-approval flow.
