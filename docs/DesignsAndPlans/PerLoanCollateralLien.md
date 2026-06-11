# Per-Loan Collateral Lien / Encumbrance Sub-Ledger

**Status:** Design (pending implementation) · **Date:** 2026-06-07 · **Scope-broadened 2026-06-12**
**Resolves card:** [#407]
**Interacts with:** immutability/ossification card [#404] (a frozen vault must have lien support baked in first)

> **Scope-broadening note (2026-06-12):** Card #407 was broadened after Codex caught a related issue on PR #538 (T-092-A loan netting). `protocolTrackedVaultBalance` is an aggregate counter that includes funds locked in active lender offers (deposited via `OfferCreateFacet._pullCreatorAssetsClassic`). Any consumer that reads it as "available cash" risks double-spending committed offer funds. The card now covers **two lien categories** under a single unified sub-ledger:
>
> - **Per-loan collateral lien** (this doc's design — unchanged).
> - **Offer-principal lock** (ERC20 lender offers locking principal in creator's vault).
>
> A companion section "§7 Offer-principal lock extension" is added at the bottom of this doc to capture the broader scope. The collateral-lien design in §§2-6 is correct and ready to implement as-is; the offer-principal lock extension specifies how the same sub-ledger covers the second category.

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

## 7. Offer-principal lock extension (scope-broadening 2026-06-12)

### 7.1 The second lien category

When a borrower creates an **ERC20 Lender offer** via `OfferCreateFacet.createOffer`, the helper `_pullCreatorAssetsClassic` (`OfferCreateFacet.sol:857`) immediately calls `vaultDepositERC20(creator, lendingAsset, lenderPull)` to lock the offer's principal in the creator's own vault. The amount locked is `params.amountMax` (or `params.amount` when amountMax=0). The `protocolTrackedVaultBalance` counter ticks by the locked amount.

The lock exists structurally — the creator's vault has the funds — but it is **not** distinguished from "free" vault funds in storage. Any consumer that reads `protocolTrackedVaultBalance[creator][lendingAsset]` as "available balance" risks double-spending the offer-locked portion. Codex caught this on PR #538 (T-092-A loan netting): an attempt to use the borrower's aggregate counter as the source for refinance fund-netting would have spent funds committed to a separate open lender offer.

### 7.2 Same sub-ledger, different key encoding

The collateral-lien sub-ledger specified in §§2-6 generalises cleanly. Both categories fit the same shape:

```solidity
struct Encumbrance {
    address asset;
    uint256 tokenId;      // 0 for ERC20
    uint256 amount;       // ERC20 amount or ERC1155 quantity
    EncumbranceKind kind; // {Collateral, OfferPrincipal}
    uint256 refId;        // loanId (Collateral) or offerId (OfferPrincipal)
    bool released;
}

enum EncumbranceKind { Collateral, OfferPrincipal }

// Keyed by a 32-byte composite to avoid two parallel maps:
mapping(bytes32 encKey => Encumbrance) liens;

// where encKey = keccak256(abi.encode(kind, refId))
// Aggregate per-user-per-asset stays the existing single map:
mapping(address user => mapping(address asset => mapping(uint256 tokenId => uint256))) encumbered;
```

The withdraw guard in §3.4 reads the SAME aggregate map for both kinds:

```solidity
freeBalance(user, asset, tokenId) = vaultProxy.balanceOf(...) − encumbered[user][asset][tokenId]
```

so a consumer never has to ask "which kind of lien is this" — they just ask "is this amount free?"

### 7.3 Offer-principal lifecycle hooks

| Trigger | Hook | Effect |
|---|---|---|
| `OfferCreateFacet._pullCreatorAssetsClassic` (Lender + ERC20) | Create | `liens[keccak(OfferPrincipal, offerId)] = {asset: lendingAsset, amount: lenderPull, kind: OfferPrincipal, refId: offerId, released: false}` + `encumbered += lenderPull` |
| `OfferCancelFacet.cancelOffer` | Release (full) | `released = true` + `encumbered -= remainingLocked` (= `amount - amountFilled`) |
| `OfferAcceptFacet._acceptOffer` (single-fill) | Release (full) | Same as cancel — entire remaining lock released as the principal flows to the borrower |
| `OfferMatchFacet.matchOffers` (partial fill, lender side) | Release (partial) | `encumbered -= matchAmount` + decrement the lien's tracked remaining amount |
| `OfferMatchFacet.matchOffers` (dust-close after partial) | Release (final) | Mark `released = true` for the remaining dust + `encumbered -= dust` |
| Lazy-expiry sweep (GTT past `expiresAt`) | Release (full) | Same as cancel |

Critical invariant: across all lifecycle paths, the **sum of encumbered decrements MUST equal the amount the principal actually leaves the vault by**. Any mismatch leaves dangling encumbrance (under-decrement) or under-attestation (over-decrement). The Permit2-style `recordVaultDepositERC20` two-step (deposit + counter tick) helps here — the counter and the lien decrement can be paired at the same single touchpoint.

### 7.4 Why this is non-trivial

- **Partial fills** (`partialFillEnabled` on) make the lien's "remaining" a moving target — every match updates two storage slots (the lien's tracked amount AND the encumbered aggregate). Cost matters; the matcher is a hot path.
- **Cancel races** — a borrower can cancel while the matcher is mid-tx; the existing reentrancy guard + `bm.accepted` checks already serialise these, but the lien decrement must happen on the SAME branch as the existing cancel/match accounting, never duplicated.
- **Lazy GTT expiry** — offers with `expiresAt` past now stay in storage until someone sweeps. The lien decrement must also be lazy — released on the first read after expiry, OR swept proactively by the keeper-bot. Recommend lazy decrement on read inside `cancelOffer` / `getFreeBalance` to keep gas predictable.
- **Migration** — existing live offers at deploy time have no liens yet. Either bulk-stamp at the migration moment (iterate the active offer list, create liens) or treat pre-migration offers as "legacy unlocked" with a one-time grandfather flag. Prefer the bulk-stamp approach so the invariant `encumbered ≥ 0` holds uniformly post-migration.

### 7.5 Implementation sequencing

Recommend two separate impl PRs after the storage + withdraw guard are in place:

1. **Collateral lien impl** (this doc's §§2-6) — touches `LoanFacet.initiateLoan`, `RepayFacet`, `PrecloseFacet`, `DefaultedFacet`, `ClaimFacet`. Smaller blast radius, all loan-lifecycle terminals.
2. **Offer-principal lock impl** (this §7) — touches `OfferCreateFacet`, `OfferCancelFacet`, `OfferAcceptFacet`, `OfferMatchFacet`. Larger blast radius, must coordinate with the matcher's hot path.

Each can ship independently as long as the withdraw guard handles both kinds (or rejects neither — both branches start permissive, then tighten in subsequent PRs).

### 7.6 What enables (cards this unblocks)

- **#530** (T-092-A loan netting) — once offer-principal locks are tracked, vault-first refinance netting becomes safe because the netting computation can read `freeBalance(borrower, principalAsset)` and trust it.
- **#539** atomic accept-and-refinance (shipped) — already uses wallet-pull which sidesteps the issue; vault-first becomes a future optimisation once §7 lands.
- **Future early-withdrawal / partial-withdrawal facets** — the withdraw guard prevents withdrawing collateral or offer-locked funds.

[#407]: https://github.com/vaipakam/vaipakam/issues/407
[#404]: https://github.com/vaipakam/vaipakam/issues/404
[#530]: https://github.com/vaipakam/vaipakam/issues/530
[#539]: https://github.com/vaipakam/vaipakam/issues/539
