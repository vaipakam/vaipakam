# Lender Position-Sale ("Sale Vehicle") Lifecycle Redesign

**Status:** design → implementation (PR #959, redesign pass).
**Origin:** #951 (createLoanSaleOffer could not complete on-chain). The
incremental-fix PR #959 went through three Codex review rounds, each surfacing a
deeper issue because the flow had never run end-to-end. Owner direction: step
back and redesign the whole lifecycle, addressing every surfaced issue in one
coherent pass.

## Scope

The lender position-sale ("sale vehicle") flow: an exiting lender lists their
live loan position at their own rate via
`EarlyWithdrawalFacet.createLoanSaleOffer`, a buyer takes over the lender side,
and the live loan's lender relationship transfers. Phase 1 is **ERC-20 principal
+ ERC-20 collateral** only (NFT-collateral lender-sale is tracked as #974).

The sale vehicle is a **Borrower-type offer** (`amount = loan.principal`,
`collateralAmount = 0` — it escrows no fresh collateral; the real collateral
stays on the live loan) linked to the live loan via
`saleOfferToLoanId` / `loanToSaleOfferId`. A buyer accepts it; `acceptOffer`
pays the sale principal to the seller (the offer creator) and auto-completes the
sale in the same transaction.

## The root cause behind most of the findings

Every terminal loan flow (repay, default, preclose, refinance, swap-to-repay, …)
calls **`LibConsolidation.consolidateToHolder(loanId, isLenderSide, ctx)`**
before mutating a side, which re-anchors that side's stored identity
(`loan.lender` / `loan.borrower`) **and** its vaulted value (`heldForLender`,
liens, reward entry, VPFI stamp) to the current position-NFT holder
(`ownerOf(tokenId)`). This keeps *stored identity == economic identity*.

`EarlyWithdrawalFacet.createLoanSaleOffer` **does not** consolidate. So when a
lender position was transferred on the secondary market but not yet
consolidated, `loan.lender` is **stale** while `ownerOf(lenderTokenId)` (the
seller who lists and whom `acceptOffer` pays) is the real economic party. The
completion path then has to choose an identity for each operation, and the two
diverge:

- `heldForLender[loanId]` physically sits in the **stored `loan.lender`** vault →
  the held-proceeds migration must pull `from` the stored lender (Codex R3-P1).
- The sale principal was paid to the **current holder** → accrued/shortfall
  settlement must be against the current holder (Codex round-2 finding-3).

Trying to satisfy both with a single hand-rolled `originalLender` identity is
what produced the P1 regression. The fix is to **remove the divergence at the
source**: consolidate the lender position to the current holder at listing time,
so `loan.lender == ownerOf(lenderTokenId) == seller` for the entire sale, and
the completion path can use `loan.lender` uniformly (identity == custody ==
who-was-paid).

## Design

### D1 — Consolidate the lender position at listing (root fix)

`createLoanSaleOffer` calls `LibConsolidation.consolidateToHolder(loanId,
/* isLenderSide */ true, ctx)` **before** it locks the NFT and creates the sale
offer. After this, `loan.lender` and `heldForLender` are re-anchored to the
seller. This mirrors the #656 pattern where the collateral-listing flows
consolidate the borrower side before binding a listing.

**Skipped case:** `consolidateToHolder` returns `Skipped` for a lender position
carrying *unreserved* `heldForLender` VPFI (the #597 `_isExcludedLive` guard) —
the lien re-key can't carry an unreserved reservation. A position in that state
cannot be safely sold (its stored/economic identity can't be unified), so
`createLoanSaleOffer` **reverts** when consolidation is skipped, with a typed
error (`SalePositionNotConsolidatable`). This is a rare edge; the seller resolves
the held VPFI first. The invariant "a successfully-listed sale has
`loan.lender == seller`" then holds unconditionally.

### D2 — Completion settles uniformly against `loan.lender`

With D1, `_completeLoanSaleImpl` reverts the round-2 `originalLender =
ownerOf(...)` change back to `originalLender = loan.lender` (now authoritative):
the held-proceeds migration, the `releaseLenderProceeds` reservation release, and
the accrued/shortfall settlement all key on the same consolidated identity.
Resolves R3-P1 and round-2 finding-3 together with no divergence.

### D3 — Direct-accept only; block sale vehicles from the range matcher

A position sale is an all-or-nothing full-principal transfer, not a range/partial
order. On the `OfferMatchFacet.matchOffers` path `_acceptOffer` runs with
`matchOverride.active` → `deferAcceptFlip = true`, so `offer.accepted` is set only
later in the dust-close block — *after* the auto-complete crossFacetCall has
already run and reverted `SaleOfferNotAccepted` (Codex R3-P2). Rather than thread
the accept-flip earlier, we **reject a sale-vehicle borrower offer from the match
path** (typed `SaleVehicleNotMatchable`). Sale vehicles are accepted through the
direct `acceptOffer` path only, where `accepted` is set before the auto-complete.

### D4 — Freeze a linked sale offer against mutation

`OfferMutateFacet._assertMutableBy` (the shared gate for `setOfferAmount` /
`setOfferRate` / `setOfferCollateral` / `modifyOffer`) gains a guard: a linked
sale offer (`saleOfferToLoanId[offerId] != 0`) is **immutable**. Once listed, the
sale offer's economics are fixed until it is accepted or cancelled — a seller
cannot lower `amount`, change the rate, or set a positive collateral after
linking, which would desync the vehicle from the live loan (Codex R3-P2). Typed
error `SaleVehicleImmutable`.

### D5 — Frontend decoder entries

`packages/lib/src/decodeContractError.ts` gains the new typed reverts so the dapp
surfaces friendly messages instead of raw selectors:
`SaleOfferCollateralMustBeERC20`, `SaleOfferAlreadyExists`, and the new
`SalePositionNotConsolidatable`, `SaleVehicleNotMatchable`, `SaleVehicleImmutable`.

### Retained from the earlier PR passes (already correct)

- Posting fix: `_submitSaleOffer` → `createOfferInternal` (reentrancy) with the
  seller as explicit creator; the `saleVehicleCreate` ceiling + collateral-pull
  exemptions.
- `completeLoanSaleInternal` (address(this)-gated) + routing `acceptOffer`'s
  auto-complete to it (accept→complete reentrancy P1).
- ERC-20-collateral Phase-1 scope (`SaleOfferCollateralMustBeERC20`).
- One-listing-per-loan guard + link teardown on completion (cancel already
  cleared the links).
- Lock the lender NFT before the create hop.

## Invariants

- A successfully-listed sale has `loan.lender == ownerOf(lenderTokenId) ==
  seller` (D1). Custody, stored identity, and who-was-paid never diverge.
- A linked sale offer is immutable and non-matchable; it can only be accepted via
  direct `acceptOffer` or cancelled (D3, D4).
- On cancel or completion both link directions and the NFT lock are cleared, so a
  genuine re-list is always possible afterward.
- Held-for-lender VPFI always moves stored→current in one atomic step (via
  consolidation at listing, then the existing migration at completion).

## Test matrix (unmocked where feasible)

1. Direct accept E2E: list → buyer accepts → auto-complete; lender migrates to
   buyer; accrued/shortfall settled against the seller; links + lock cleared.
2. Transferred-but-unconsolidated position: list consolidates to the current
   holder; settlement + held-proceeds all key on that holder; no divergence.
3. Unreserved-held position: `createLoanSaleOffer` reverts
   `SalePositionNotConsolidatable`.
4. Match path: matching a linked sale vehicle reverts `SaleVehicleNotMatchable`.
5. Mutation: `setOfferAmount`/`setOfferRate`/`setOfferCollateral`/`modifyOffer`
   on a linked sale offer reverts `SaleVehicleImmutable`.
6. NFT-collateral loan: `createLoanSaleOffer` reverts
   `SaleOfferCollateralMustBeERC20` (#974 tracks lifting this).
7. Cancel: links + lock cleared, no collateral-refund attempt, re-list works.
8. Duplicate listing reverts `SaleOfferAlreadyExists`.

## Out of scope / follow-ups

- #974 — NFT-collateral lender-sale (complete/cancel collateral handling).
- #927 — re-enable the listing UI once the flow is solid.
