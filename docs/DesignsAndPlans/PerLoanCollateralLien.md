# Per-Loan Collateral Lien / Encumbrance Sub-Ledger

**Status:** Design (pending implementation) · **Date:** 2026-06-07
**Resolves card:** [#407]
**Interacts with:** immutability/ossification card [#404] (a frozen vault must have lien support baked in first)

---

## 1. Goal

Make the ethos guarantee *"this exact collateral is locked for this exact loan"* **provable on-chain**, not merely implied by the absence of a withdraw path. Today collateral is segregated per **user** (their own `ERC1967` vault) but never earmarked per **loan**; the only "lock" is that no function moves a vaulted asset out while a loan is Active. We add an explicit lien sub-ledger with `withdrawable = balance − Σ active liens`.

This is a **reinforcement of ethos E1 (no commingling)** — see `../FunctionalSpecs` and the platform-ethos memory. It must not itself introduce any cross-user shared balance.

## 2. Current state (verified)

- **Vault** (`VaipakamVaultImplementation.sol`): holds raw ERC20/721/1155 balances; all outflows (`withdrawERC20:167`, `withdrawERC721:201`, `withdrawERC1155:244`) are `onlyDiamond`; inbound NFT pushes are rejected unless from the Diamond (`onERC721Received:673`). UUPS-upgradeable; `__gap[49]` at tail (`:738`).
- **VaultFactoryFacet**: all asset moves route through cross-facet wrappers (`vaultWithdrawERC20:391`, `…721:831`, `…1155:888`, deposit variants); maintains `protocolTrackedVaultBalance[user][token]` (`:427`) — a cumulative protocol-deposit counter used only for the stuck-token recovery cap (T-054), **not** a lock.
- **No existing per-loan encumbrance** anywhere (grep: no `lien`/`encumber`/`reserved`/`withdrawable`). Salary (PayrollFacet) and VPFI-stake have their own balance gates but are unrelated to collateral.
- **No user-facing "free withdraw"** of vaulted collateral exists — every outflow goes through a Diamond settlement path (repay/claim/default/liquidation/preclose/refinance). So a lien only needs to guard the Diamond's own `vaultWithdraw*` calls, plus any future user-withdraw entry point.

### Collateral lifecycle (where the lien is created / released / transferred)

| Stage | Facet:func | Collateral custody | Lien action |
| --- | --- | --- | --- |
| Loan init | `LoanFacet.initiateLoan` | stays in collateral owner's vault | **CREATE** lien |
| Full repay | `RepayFacet.repayLoan` (records borrower claim ~`:364`) | borrower vault | **RELEASE** |
| Claim | `ClaimFacet.claimAsBorrower/Lender` | recipient vault | (already released/transferred) |
| Time-default, liquid | `DefaultedFacet` (`vaultWithdraw…(borrower→Diamond)`, swap) | borrower → Diamond → split | **RELEASE** on swap-out |
| Time-default, illiquid | `DefaultedFacet` (`vaultWithdraw…(borrower→lender)`) | borrower → lender vault | **TRANSFER/RELEASE** |
| HF-liquidation + fallback | `RiskFacet` / `LibFallback` | borrower → Diamond (temp) | **RELEASE** on swap-out |
| Preclose / transfer / offset | `PrecloseFacet` | borrower vault / continues | **RELEASE** (direct) / **carry** (transfer keeps lien, new borrower) |
| Refinance | `RefinanceFacet` | borrower vault | **carry/re-key** to continuing loan |

## 3. Design

### 3.1 Storage location — Diamond shared storage (not the vault)
Put the ledger in `LibVaipakam.Storage` (append-only), **not** in the per-user vault, because:
- Liquidation/default guards (`RiskFacet`, `DefaultedFacet`) read it directly without a proxy hop.
- It survives a future **vault ossification** (#404) — the Diamond holds ground truth; a frozen vault implementation need not change.
- Cross-loan aggregation (`getEncumbered(user, asset, tokenId)`) is a single storage read.

### 3.2 Schema (sketch)
```solidity
struct CollateralLien {
    uint256 loanId;
    address user;        // collateral owner (whose vault holds it)
    address asset;
    uint256 tokenId;     // ERC721/1155; 0 for ERC20
    uint256 amount;      // wei (ERC20) | 1 (ERC721) | quantity (ERC1155)
    bool    released;
}
// in Storage (appended):
mapping(uint256 loanId => CollateralLien) collateralLien;          // one lien per loan
mapping(address user => mapping(address asset => mapping(uint256 tokenId => uint256))) encumbered; // aggregate
```
One lien per loan is sufficient (a loan has one collateral leg). The `encumbered[user][asset][tokenId]` aggregate is the fast path for the withdrawal guard.

### 3.3 Lifecycle hooks
- **Create** in `LoanFacet.initiateLoan` from the stamped `Loan.collateralAsset/Amount/TokenId/Quantity/AssetType`: write the lien + `encumbered += amount`.
- **Release** in every terminal that frees collateral (`repayLoan`, `precloseDirect`, claim-back): set `released = true`, `encumbered -= amount`.
- **Transfer/consume** on default/liquidation: when collateral leaves the borrower vault (to Diamond for swap, or to lender), decrement `encumbered` for the borrower; do **not** re-lien the proceeds (they become claimable, not collateral).
- **Carry/re-key** on obligation-transfer (`transferObligationViaOffer`) and refinance: the loan continues with new borrower/terms — move/refresh the lien to match the updated `Loan` collateral fields (Ben's collateral replaces Alice's).

### 3.4 Withdrawal guard
Add an `assertNotEncumbered(user, asset, tokenId, amount)` (or `freeBalance` view) check in the vault-withdraw chokepoints in `VaultFactoryFacet` for any path that is **not** a protocol settlement of the owning loan. Settlement paths (repay/default/etc.) release the lien *before* withdrawing, so they pass. The guard is the safety net for any future user-facing withdraw and for partial-withdrawal/early-withdrawal facets.

### 3.5 Asset-type encoding
- ERC20: `(asset, 0, amount)`.
- ERC721: `(asset, tokenId, 1)`.
- ERC1155: `(asset, tokenId, quantity)`.

### 3.6 Provability surface (the point of the card)
Expose `getLoanCollateralLien(loanId)` and `getEncumbered(user, asset, tokenId)` views so the frontend/lender can prove, on-chain, the exact collateral backing a given loan and that it cannot be withdrawn. Wire into the position NFT metadata (already surfaces `collateralLockedNow`).

## 4. Interaction notes

- `protocolTrackedVaultBalance` (recovery cap) is **unaffected** — liens live outside it; the stuck-token math (`balanceOf − tracked`) keeps working.
- **Ossification (#404):** since the ledger is Diamond-side, freezing the vault implementation later does not strand liens. But the vault-withdraw guard call must exist before any vault freeze.
- Cross-facet calls run with `msg.sender == address(this)`, so guard helpers follow the existing internal-gate idiom (`LibAuth:99`).

## 5. Test plan

- Lien created at init; `getEncumbered` reflects it; a (hypothetical/forced) non-settlement withdraw of the locked amount reverts.
- Release on full repay → `encumbered` back to 0 → borrower can claim/withdraw.
- Default (liquid + illiquid) → lien released as collateral leaves; no dangling encumbrance.
- Obligation-transfer / refinance → lien re-keyed to the continuing loan's (new) collateral; old leg cleared.
- ERC20 / ERC721 / ERC1155 each covered.
- Multi-loan same user: two loans, partial; assert per-loan attribution and that `withdrawable = balance − Σ liens`.

## 6. Acceptance criteria

Ledger in `LibVaipakam.Storage` (append-only); create/release/transfer hooks across all lifecycle terminals; withdraw-chokepoint guard; provability views + NFT metadata wiring; full asset-type + lifecycle tests; release-note + FunctionalSpec update (E1 now provable). Note dependency ordering vs #404 (guard must precede any vault freeze).

[#407]: https://github.com/vaipakam/vaipakam/issues/407
[#404]: https://github.com/vaipakam/vaipakam/issues/404
