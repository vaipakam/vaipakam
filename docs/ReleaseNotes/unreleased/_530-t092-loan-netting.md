## Thread — T-092-A: loan netting with vault-first wallet-fallback (#530)

Closes the "borrower must maintain separate wallet ERC20 balance + standing diamond approval" requirement for keeper-driven refinance. The new fund-source pattern is vault-first wallet-fallback: the refinance payoff (treasury fee + lender share) consumes the borrower's VAULT balance first, then falls back to the WALLET (legacy pre-#530 path) for any shortfall.

### What's new

**Contract change** ([`RefinanceFacet.sol:285-396`](contracts/src/facets/RefinanceFacet.sol#L285-L396)) — the old two-call `safeTransferFrom(borrower, treasury, …)` + `vaultDepositERC20From(borrower, oldLender, …)` flow is now split into two legs (treasury + lender), each running:

```
fromVault   = min(borrower's vault counter, owed)
fromWallet  = owed - fromVault
[vault leg] vaultWithdrawERC20(borrower, asset, recipient, fromVault)
[wallet leg] legacy path (safeTransferFrom for treasury;
             vaultDepositERC20From for lender share)
```

The vault-to-vault transfer to the old lender uses the existing `vaultWithdrawERC20` + `recordVaultDepositERC20` two-step pattern (the same shape the Permit2 deposit path uses). Diamond never custodies the asset; the funds move vault-to-vault in two atomic side-effects.

### Why hybrid and not vault-only

`OfferAcceptFacet` routes the new lender's principal to the borrower's WALLET (line 840), not the vault. So a borrower who hasn't separately deposited into their vault has no vault balance to net against. Vault-only would have broken every existing refinance test fixture + the borrower-direct flow. The hybrid preserves backward compatibility while delivering the netting benefit to borrowers who fund their vault.

A borrower who routinely deposits into their vault (the common case — VPFI rewards + claim payouts + offer collateral release all land there) gets auto-refinance with zero wallet interactions at refinance time. A borrower who keeps funds in the wallet (the legacy default) still works through the unchanged safeTransferFrom path — no UX regression.

### Applies uniformly across collateral types

The netting happens on the PRINCIPAL leg (always ERC20), not the collateral side. Liquid + illiquid + NFT collateral are all handled identically. Collateral handoff lower in the file (lines 349-387, three types) is unchanged.

### Discovery: extend was already vault-first

The matching `AutoLifecycleFacet.extendLoanInPlace` flow (`_routeInterest` at [AutoLifecycleFacet.sol:800-842](contracts/src/facets/AutoLifecycleFacet.sol#L800-L842)) was implemented vault-first from the start in Phase 3 (#507). Card #535 was filed on the wrong assumption that extend pulled from the wallet — closed as already-implemented.

### Verification

- forge build clean (`viaIR + optimizer=200`).
- RefinanceFacetTest 34/34 (every existing test still passes — wallet-fallback path works identically).
- Two new tests added under T-092-A:
  - `test_T092A_LoanNetting_VaultFundedFullyCoversPayoff` — vault has funds → wallet untouched.
  - `test_T092A_LoanNetting_VaultEmptyFallsBackToWallet` — vault empty → wallet drains (legacy).
- T092AutoLifecycleIntegrationTest 17/17, LoanFacetTest broader 100/100 green.
- Deploy-sanity 12/12.

### Out of scope

- Routing the offer-accepted principal to the borrower's vault (would require OfferAcceptFacet changes). Out of #530's scope; could be a future enhancement that turns the hybrid path into vault-only.
- Dapp surface for the new "pre-fund vault" suggestion. Borrowers who want full wallet-free refinance need to be told to deposit; can be folded into #537 (opt-in friction) or a separate dapp PR.
