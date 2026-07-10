// src/libraries/LibEncumbrance.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibEncumbrance
 * @notice #407 (2026-06-12) — vault encumbrance sub-ledger. Unified
 *         lien tracking for BOTH categories described in
 *         `docs/DesignsAndPlans/PerLoanCollateralLien.md`:
 *
 *           1. **Per-loan collateral lien** (§§2-6): created at
 *              `LoanFacet.initiateLoan` for ERC-20 LOANS only (#569
 *              D-1 — NFT rentals are not liened); released / decremented
 *              / re-keyed on every loan-lifecycle terminal or slice
 *              flow that frees collateral (`RepayFacet.repayLoan`,
 *              `PrecloseFacet.precloseDirect` / `transferObligationViaOffer`,
 *              `DefaultedFacet.triggerDefault`, `RefinanceFacet`,
 *              `SwapToRepayFacet` / `SwapToRepayIntentFacet`,
 *              `PartialWithdrawalFacet`, the internal-match settlement).
 *              `ClaimFacet` does NOT touch the lien — release happens
 *              strictly upstream (see EncumbranceLifecycleMap.md §4.5).
 *
 *           2. **Offer-principal lock** (§7): created at
 *              `OfferCreateFacet._pullCreatorAssetsClassic` for ERC20
 *              Lender offers; released partial on each
 *              `OfferMatchFacet.matchOffers` consumption, final on
 *              cancel / single-fill accept / dust-close / lazy-expiry.
 *
 *         Both categories share one storage shape (`LibVaipakam.
 *         Encumbrance`) and one aggregate
 *         (`s.encumbered[user][asset][tokenId]`). The withdraw guard
 *         in `VaultFactoryFacet.vaultWithdrawERC20` reads the aggregate
 *         and never has to distinguish kinds — it just asks "is this
 *         amount free?".
 *
 * @dev    Helpers are internal-only and operate directly on storage.
 *         No event emissions here — the calling facets emit their own
 *         lifecycle events; lien state-change events are a
 *         deliberately out-of-scope simplification (the aggregate map
 *         is queryable on-chain at any time).
 */
library LibEncumbrance {
    /// @notice Raised when a release attempt would underflow the
    ///         aggregate — a sign that the bookkeeping has drifted.
    ///         Surfaces loudly rather than silently saturating so
    ///         off-chain reconciliation can spot the cause.
    error EncumbranceUnderflow(
        address user,
        address asset,
        uint256 tokenId,
        uint256 requested,
        uint256 available
    );

    /// @notice Raised when create is called for a lien that already
    ///         has a non-released row at the same key — a sign of a
    ///         double-create bug. Defensive guard; the loan and offer
    ///         lifecycles each create at most once per key in practice.
    error EncumbranceAlreadyExists(uint256 key);

    /// @notice #393 v1-d — raised when a fill slice or an intent-capital
    ///         withdraw exceeds the un-lent capital the lender has funded for
    ///         that `(owner, lend, coll)` intent. A solver can never fill more
    ///         than was funded, and a lender can never withdraw more un-lent
    ///         capital than remains liened.
    error IntentCapitalInsufficient(
        address owner,
        address lend,
        address coll,
        uint256 requested,
        uint256 available
    );

    // ─── Collateral lien — per-loan ─────────────────────────────────────

    /// @notice Create a collateral lien from a freshly-initiated loan.
    ///         Called from `LoanFacet.initiateLoan` AFTER the loan row
    ///         has been written (`loan.collateralAsset` / `Amount` /
    ///         `TokenId` / `Quantity` / `AssetType` already final).
    /// @dev    #569 lifecycle map decision D-1 (2026-06-13) — liened for
    ///         **ERC-20 LOANS only** (`loan.assetType == ERC20`),
    ///         covering ERC-20 + NFT collateral. NFT-RENTAL loans
    ///         (`assetType` ERC721/1155) are NOT liened: their "collateral"
    ///         is the prepay+buffer pool, which drains continuously
    ///         through the intrinsic rental-deduction mechanism. The
    ///         only side-door that could drain it
    ///         (`withdrawVPFIFromVault` when `prepayAsset == VPFI`) is
    ///         closed by decision D-2 (VPFI forbidden as a rental prepay
    ///         asset), so the rental pool needs no lien and no
    ///         per-deduction decrement wiring. See
    ///         `docs/DesignsAndPlans/EncumbranceLifecycleMap.md` §2.
    function createCollateralLien(
        uint256 loanId,
        LibVaipakam.Loan storage loan
    ) internal {
        // D-1: only ERC-20 loans carry a collateral lien. NFT rentals
        // (the principal/lent asset is an NFT) escrow a prepay pool that
        // is intentionally drained by the rental mechanism, not a lien.
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.loanCollateralLien[loanId];
        // Tombstone re-use: a previously-released lien at the same
        // loanId is fine (loans aren't re-used, but defensive); a
        // currently-active lien is the double-create bug.
        if (lien.user != address(0) && !lien.released) {
            revert EncumbranceAlreadyExists(loanId);
        }

        (address asset, uint256 tokenId, uint256 amount) =
            _encodeCollateralFields(loan);

        s.loanCollateralLien[loanId] = LibVaipakam.Encumbrance({
            user: loan.borrower,
            asset: asset,
            tokenId: tokenId,
            amount: amount,
            assetType: loan.collateralAssetType,
            released: false
        });
        s.encumbered[loan.borrower][asset][tokenId] += amount;
    }

    /// @notice Release a collateral lien in full. Idempotent — already-
    ///         released or empty rows are no-ops (so terminal paths
    ///         don't have to track whether the lien was already
    ///         released by a sibling facet).
    function releaseCollateralLien(uint256 loanId) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.loanCollateralLien[loanId];
        if (lien.released || lien.user == address(0)) return;
        _decrementAggregate(lien.user, lien.asset, lien.tokenId, lien.amount);
        lien.released = true;
        // #569 round-7 P1 — zero the per-loan amount on release so a
        // released tombstone can never be mis-read as a live lien. The
        // `released` flag is the source of truth, but leaving a stale
        // non-zero `amount` is a footgun (it let `claimAsLenderWithRetry`
        // fold a bogus full-collateral claim off a released row). Callers
        // that read `.amount` now always see 0 once released.
        lien.amount = 0;
    }

    /// @notice Decrement an active collateral lien by `consumed`. Used
    ///         by any flow that legitimately moves SOME collateral out
    ///         of the borrower's vault while leaving the loan ACTIVE:
    ///           - {RiskFacet.triggerPartialLiquidation} (slice swap),
    ///           - {RepayFacet._autoLiquidatePeriodShortfall} (periodic
    ///             interest shortfall slice),
    ///           - {RepayFacet} NFT-rental daily/partial deduction
    ///             (rental fee flowing to lender),
    ///           - internal-match partial consumption.
    ///         The lien struct stays alive; only `amount` (and the
    ///         aggregate) drops. Idempotent on already-released rows
    ///         (no-op).
    /// @dev    #407 PR 4 round-1 Codex P1 (2026-06-12) — Codex caught
    ///         that the original "release-on-terminal-only" model
    ///         blocked legitimate active-loan slice withdrawals.
    function decrementCollateralLien(uint256 loanId, uint256 consumed) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.loanCollateralLien[loanId];
        if (lien.released || lien.user == address(0) || consumed == 0) return;
        if (consumed > lien.amount) {
            revert EncumbranceUnderflow(
                lien.user,
                lien.asset,
                lien.tokenId,
                consumed,
                lien.amount
            );
        }
        _decrementAggregate(lien.user, lien.asset, lien.tokenId, consumed);
        unchecked {
            lien.amount -= consumed;
        }
    }

    /// @notice Increment an active collateral lien by `added`. Used by
    ///         {AddCollateralFacet.addCollateral} when a borrower tops
    ///         up the existing pledge.
    /// @dev    #407 PR 4 round-1 Codex P2 (2026-06-12) — Codex caught
    ///         that `addCollateral` previously grew `loan.collateralAmount`
    ///         without growing the lien, leaving the top-up portion
    ///         withdrawable through other ERC20 surfaces (e.g. the VPFI
    ///         withdraw path).
    function incrementCollateralLien(uint256 loanId, uint256 added) internal {
        if (added == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.loanCollateralLien[loanId];

        // #569 Codex #572 round-4 P1 — create-if-absent. A
        // FallbackPending top-up (`AddCollateralFacet.addCollateral`)
        // adds collateral while the loan's lien was RELEASED at
        // default-entry. The top-up sits in the vault and must be
        // protected immediately — even if it doesn't cure the loan in
        // the same call — or it could be drained (e.g. VPFI via
        // `withdrawVPFIFromVault`) before a later `_cureFallback`
        // recreates the lien for the inflated `collateralAmount`. So a
        // released / empty lien is CREATED here, sized to `added` (the
        // vault portion), keyed to the loan's collateral identity —
        // NOT to `collateralAmount` (which includes the snapshot
        // collateral still held in the Diamond during FallbackPending).
        // No-op on NFT rentals (D-1).
        LibVaipakam.Loan storage loan = s.loans[loanId];
        if (lien.released || lien.user == address(0)) {
            if (loan.assetType != LibVaipakam.AssetType.ERC20) return;
            (address asset, uint256 tokenId, ) = _encodeCollateralFields(loan);
            s.loanCollateralLien[loanId] = LibVaipakam.Encumbrance({
                user: loan.borrower,
                asset: asset,
                tokenId: tokenId,
                amount: added,
                assetType: loan.collateralAssetType,
                released: false
            });
            s.encumbered[loan.borrower][asset][tokenId] += added;
            return;
        }
        s.encumbered[lien.user][lien.asset][lien.tokenId] += added;
        lien.amount += added;
    }

    // ─── Lender-proceeds reservation (VPFI) ─────────────────────────────

    /// @notice #585 — reserve a loan's VPFI lender PROCEEDS against the
    ///         user-facing unstake path. When an internal match settles a
    ///         VPFI-principal loan, the proceeds are deposited into the
    ///         (possibly transferred-away) stored lender's vault and owed
    ///         to the CURRENT lender-position holder via a `lenderClaims`
    ///         row. VPFI is the one principal asset with a user-facing
    ///         tracked-balance exit (`VPFIDiscountFacet.withdrawVPFIFromVault`),
    ///         so this ticks the shared `encumbered` aggregate (tokenId 0,
    ///         ERC20) under the stored lender — exactly the aggregate that
    ///         path's free-balance guard subtracts — blocking a front-run
    ///         unstake until the holder claims. Records the ticked amount
    ///         per loan so the release is exact.
    ///
    ///         #954 (§1.1) — now called for EVERY ERC20 lender-proceeds
    ///         freeze, not just VPFI. `freeBalance` (which the signed-offer
    ///         materialisation path consults) subtracts `s.encumbered` for
    ///         any asset, so a transferred-away stored lender could otherwise
    ///         spend a non-VPFI frozen proceeds as offer/intent capital
    ///         before the current holder delists and claims. The asset-keyed
    ///         aggregate makes the reservation correct for any principal
    ///         asset; the VPFI-only restriction was never a body constraint.
    function encumberLenderProceeds(
        uint256 loanId,
        address lender,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #592 — record the ASSET this loan's reservation is under so the
        // release decrements the SAME aggregate, regardless of what asset the
        // claim record ends up holding. A loan reserves lender-proceeds at its
        // single terminal, so the asset is written once; a second reserve under
        // a DIFFERENT asset would make the single per-loan amount span two
        // aggregates that one release can't unwind — that's a state-corruption
        // invariant break, so assert it cannot happen (Panic, no ABI surface).
        if (s.lenderProceedsEncumbered[loanId] == 0) {
            s.lenderProceedsEncumberedAsset[loanId] = asset;
        } else {
            assert(s.lenderProceedsEncumberedAsset[loanId] == asset);
        }
        s.encumbered[lender][asset][0] += amount;
        s.lenderProceedsEncumbered[loanId] += amount;
    }

    /// @notice #585 — release a loan's VPFI lender-proceeds reservation
    ///         (see {encumberLenderProceeds}). Called from
    ///         `ClaimFacet._claimAsLenderImpl` immediately BEFORE the
    ///         proceeds withdraw, so the withdraw guard sees them as free.
    ///         Idempotent + keyed off the per-loan record → a no-op for
    ///         every loan that never reserved (non-VPFI, or any
    ///         lender-proceeds path not yet wired to reserve). #592 — releases
    ///         under the asset RECORDED at reserve time
    ///         (`s.lenderProceedsEncumberedAsset[loanId]`), not a passed-in
    ///         asset, so the decrement always matches the reserve regardless of
    ///         the claim record's asset (tokenId 0).
    function releaseLenderProceeds(
        uint256 loanId,
        address lender
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 reserved = s.lenderProceedsEncumbered[loanId];
        if (reserved == 0) return;
        // #592 — release under the asset the reservation was RECORDED under,
        // NOT the loan's principal asset nor the claim record's asset (which
        // can differ — e.g. an in-kind default reserved the collateral). This
        // guarantees the decrement hits the same aggregate the reserve ticked,
        // so it can never underflow an unrelated bucket while leaving the real
        // reservation stuck.
        address asset = s.lenderProceedsEncumberedAsset[loanId];
        _decrementAggregate(lender, asset, 0, reserved);
        s.lenderProceedsEncumbered[loanId] = 0;
        s.lenderProceedsEncumberedAsset[loanId] = address(0);
    }

    // ─── #998 S10 (#1006) Class B — ACTIVE-loan held reservation ─────────────
    //
    // A DEDICATED per-loan reservation for a mid-loan Class B lender-share park
    // (`LibCloseoutFreeze._parkActiveLenderShare`), kept SEPARATE from the
    // single-terminal `lenderProceedsEncumbered` ledger so an active park's
    // reservation (payment asset) and a later in-kind terminal reservation
    // (collateral asset) coexist on ONE loan without tripping the single-asset
    // assert (Codex #1122-rework fresh-round P1). The aggregate is asset-keyed, so
    // both land in different slots; only the per-loan ledger was single-asset.

    /// @notice Reserve `amount` of `asset` held for the lender, under a per-loan
    ///         (amount, asset) record distinct from {encumberLenderProceeds}. `+=`
    ///         accumulates — an active loan may freeze several inline shares (all
    ///         in the same payment asset, so the per-loan asset stays consistent).
    function encumberActiveHeld(
        uint256 loanId,
        address lender,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.heldForLenderEncumbered[loanId] == 0) {
            s.heldForLenderEncumberedAsset[loanId] = asset;
        } else {
            assert(s.heldForLenderEncumberedAsset[loanId] == asset);
        }
        s.encumbered[lender][asset][0] += amount;
        s.heldForLenderEncumbered[loanId] += amount;
    }

    /// @notice Release the active-held reservation in full, under the RECORDED
    ///         asset (loan-keyed) so it unwinds the exact aggregate the reserve
    ///         ticked even after a migration re-pointed `loan.lender`. Idempotent
    ///         no-op when nothing was parked. Called at `claimAsLender` + backstop
    ///         absorb, alongside {releaseLenderProceeds}, before the held withdraw.
    function releaseActiveHeld(uint256 loanId, address lender) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 reserved = s.heldForLenderEncumbered[loanId];
        if (reserved == 0) return;
        address asset = s.heldForLenderEncumberedAsset[loanId];
        _decrementAggregate(lender, asset, 0, reserved);
        s.heldForLenderEncumbered[loanId] = 0;
        s.heldForLenderEncumberedAsset[loanId] = address(0);
    }

    /// @notice Migrate the active-held reservation `oldLender → newUser` when the
    ///         lender position moves (consolidation / sale) and the held follows.
    ///         Moves ONLY the aggregate; the per-loan record is loan-keyed and
    ///         untouched, so a later `releaseActiveHeld(loanId, loan.lender)` (now
    ///         `newUser`) unwinds the right bucket. Mirrors {rekeyLienToHolder}'s
    ///         lender branch. Reads `oldLender` from the live loan, so callers
    ///         invoke it BEFORE re-anchoring `loan.lender`. No-op when nothing is
    ///         reserved or the holder is unchanged.
    function migrateActiveHeld(uint256 loanId, address newUser) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 reserved = s.heldForLenderEncumbered[loanId];
        if (reserved == 0) return;
        address oldLender = s.loans[loanId].lender;
        if (newUser == oldLender) return;
        address asset = s.heldForLenderEncumberedAsset[loanId];
        _decrementAggregate(oldLender, asset, 0, reserved);
        s.encumbered[newUser][asset][0] += reserved;
    }

    // ─── #661 — borrower default-surplus reservation (mirror of #592) ───────

    /// @notice #661 — reserve a VPFI borrower-surplus against the unstake path,
    ///         the borrower-side analog of {encumberLenderProceeds}. A liquid
    ///         default / liquidation returns the surplus to the borrower's vault
    ///         as a `borrowerClaims` row; without this reservation a borrower who
    ///         transferred their position could `withdrawVPFIFromVault` it before
    ///         the current holder claims. Records the asset once per loan
    ///         (always the principal asset here) and adds to the per-loan amount
    ///         + the shared `encumbered` aggregate.
    ///
    ///         #954 (§2.1) — now called for EVERY ERC20 borrower-surplus
    ///         freeze on the sanctioned swap-to-repay close-out, not just
    ///         VPFI. Any tracked ERC20 minus `s.encumbered` is spendable via
    ///         the signed-offer materialisation path, so a transferred-away
    ///         stored borrower could consume a non-VPFI frozen surplus before
    ///         the current holder claims. The asset-keyed aggregate handles
    ///         any principal asset; the VPFI-only note was a call-site
    ///         convention, never a body constraint.
    function encumberBorrowerProceeds(
        uint256 loanId,
        address borrower,
        address asset,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.borrowerProceedsEncumbered[loanId] == 0) {
            s.borrowerProceedsEncumberedAsset[loanId] = asset;
        } else {
            assert(s.borrowerProceedsEncumberedAsset[loanId] == asset);
        }
        s.encumbered[borrower][asset][0] += amount;
        s.borrowerProceedsEncumbered[loanId] += amount;
    }

    /// @notice #661 — release a loan's VPFI borrower-surplus reservation (see
    ///         {encumberBorrowerProceeds}). Called from `ClaimFacet.claimAsBorrower`
    ///         immediately BEFORE the surplus withdraw, so the withdraw guard
    ///         sees it as free. Idempotent + keyed off the per-loan record → a
    ///         no-op for every loan that never reserved. Releases under the asset
    ///         RECORDED at reserve time, so the decrement always matches.
    function releaseBorrowerProceeds(
        uint256 loanId,
        address borrower
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 reserved = s.borrowerProceedsEncumbered[loanId];
        if (reserved == 0) return;
        address asset = s.borrowerProceedsEncumberedAsset[loanId];
        _decrementAggregate(borrower, asset, 0, reserved);
        s.borrowerProceedsEncumbered[loanId] = 0;
        s.borrowerProceedsEncumberedAsset[loanId] = address(0);
    }

    // ─── Intent working-capital lien — #393 v1-d ────────────────────────

    /// @notice Lien `amount` of `owner`'s just-deposited intent working
    ///         capital for the `(lend, coll)` pair. Mirrors an offer's
    ///         principal lock ({createOfferPrincipalLien}): the amount is held
    ///         BOTH in the per-intent capital counter (`lenderIntentCapital`)
    ///         AND the shared `encumbered` aggregate (tokenId 0, ERC20) under
    ///         `owner`. So it is NOT free balance and no vault-withdraw door
    ///         can drain it except the intent's own exit
    ///         ({unlienIntentCapital}). The caller MUST have already deposited
    ///         `amount` into `owner`'s vault. This is what makes the
    ///         repaid-proceeds double-spend structurally impossible: funded
    ///         capital lives here (encumbered), repaid proceeds return as
    ///         separate free balance + a Position-NFT claim — two disjoint
    ///         buckets the exit door and the claim path each touch exactly one
    ///         of.
    function lienIntentCapital(
        address owner,
        address lend,
        address coll,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.lenderIntentCapital[owner][lend][coll] += amount;
        s.encumbered[owner][lend][0] += amount;
    }

    /// @notice Release `amount` of `owner`'s un-lent intent capital for the
    ///         `(lend, coll)` pair from the lien back to FREE balance. Two
    ///         callers: (1) `OfferMatchFacet.matchIntent` releases each fill
    ///         slice so the existing materialize path (which asserts free
    ///         balance) can consume it; (2)
    ///         `LenderIntentFacet.withdrawLenderIntentCapital` releases the
    ///         remainder so it can be withdrawn to the lender's wallet — the
    ///         cancel-offer exit. Reverts {IntentCapitalInsufficient} if
    ///         `amount` exceeds the liened capital; a fill or withdraw can
    ///         never exceed what was funded.
    function unlienIntentCapital(
        address owner,
        address lend,
        address coll,
        uint256 amount
    ) internal {
        if (amount == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 liened = s.lenderIntentCapital[owner][lend][coll];
        if (amount > liened) {
            revert IntentCapitalInsufficient(owner, lend, coll, amount, liened);
        }
        unchecked {
            s.lenderIntentCapital[owner][lend][coll] = liened - amount;
        }
        _decrementAggregate(owner, lend, 0, amount);
    }

    /// @notice Re-create a collateral lien from the loan row's
    ///         current `(borrower, collateralAsset, …, collateralAmount)`
    ///         encoding. Used by the FallbackPending → Active cure
    ///         path ({AddCollateralFacet._cureFallback}) which lands
    ///         the snapshot collateral back in the borrower's vault
    ///         and re-activates the loan; the lien (released early at
    ///         {DefaultedFacet.triggerDefault} entry) must be reinstated
    ///         or the cured loan would have unprotected collateral.
    /// @dev    Tombstone-safe — if a `released:true` lien is already at
    ///         the slot it's overwritten with a fresh `released:false`
    ///         row. The aggregate is bumped only by the new amount
    ///         (any old residual was already drained at release).
    ///         #407 PR 4 round-1 Codex P1 #2 (2026-06-12).
    function recreateCollateralLien(
        uint256 loanId,
        LibVaipakam.Loan storage loan
    ) internal {
        // #569 D-1 — NFT-rental loans are never liened; recreate is a
        // no-op for them (consistent with `createCollateralLien`).
        if (loan.assetType != LibVaipakam.AssetType.ERC20) return;

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        (address asset, uint256 tokenId, uint256 amount) =
            _encodeCollateralFields(loan);
        s.loanCollateralLien[loanId] = LibVaipakam.Encumbrance({
            user: loan.borrower,
            asset: asset,
            tokenId: tokenId,
            amount: amount,
            assetType: loan.collateralAssetType,
            released: false
        });
        s.encumbered[loan.borrower][asset][tokenId] += amount;
    }

    /// @notice Re-key a collateral lien from one loan id to another
    ///         when the old loan closes + the new loan inherits the
    ///         same collateral identity. On the `sameKey` path the lien
    ///         stays on the same `(user, asset, tokenId)` tuple → the
    ///         aggregate does NOT change and the collateral never leaves
    ///         the vault.
    /// @dev    #576 — LIVE. `RefinanceFacet._refinanceLoanLogic` calls this
    ///         in place of the legacy return-old + pledge-fresh model: the
    ///         collateral stays in `oldLoan.borrower`'s vault and the lien
    ///         retags old→new via the `sameKey` branch (no aggregate change,
    ///         no second collateral lock). RefinanceFacet pins the new loan's
    ///         `borrower` + collateral identity to the old loan's BEFORE
    ///         calling, so `sameKey` always holds for a refinance carry-over
    ///         (the offer pledges no fresh collateral and `initiateLoan`
    ///         skips the fresh lien — see the refinance-origin skips there).
    ///         #576 Codex round-7 P1 — this is now STRICT: it performs the
    ///         retag ONLY when the old lien's key matches the new loan
    ///         EXACTLY (`sameKey`), and returns `false` otherwise WITHOUT
    ///         mutating any lien. The previous `!sameKey` release+create
    ///         fallback was unsafe on the carry-over path: a carry-over offer
    ///         pledges NO fresh collateral, so creating a fresh lien for the
    ///         new borrower would back the replacement loan with an
    ///         accounting-only lien against an empty vault. The borrower-
    ///         migration race reaches `!sameKey` (old lien keyed to the
    ///         migrated-in borrower B, new loan borrower A after the NFT
    ///         returns to A); the caller (RefinanceFacet) reverts the whole
    ///         accept-and-refinance when this returns `false`.
    /// @return retagged True iff a same-key retag was performed; false means
    ///         the caller must reject the carry-over (no state was changed).
    function rekeyCollateralLienOnRefinance(
        uint256 oldLoanId,
        uint256 newLoanId,
        LibVaipakam.Loan storage newLoan
    ) internal returns (bool retagged) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage oldLien = s.loanCollateralLien[oldLoanId];
        if (oldLien.released || oldLien.user == address(0)) return false;

        // Compare the new loan's collateral encoding against the old
        // lien. If they match (no collateral change), just retag —
        // aggregate stays as-is. If they differ, release + create so
        // the aggregate ticks correctly under each (user, asset,
        // tokenId) tuple.
        (address newAsset, uint256 newTokenId, uint256 newAmount) =
            _encodeCollateralFields(newLoan);
        bool sameKey =
            oldLien.user == newLoan.borrower &&
            oldLien.asset == newAsset &&
            oldLien.tokenId == newTokenId &&
            oldLien.amount == newAmount &&
            oldLien.assetType == newLoan.collateralAssetType;

        if (sameKey) {
            // Same (user, asset, tokenId, amount, kind) → just move
            // the record key.
            s.loanCollateralLien[newLoanId] = LibVaipakam.Encumbrance({
                user: oldLien.user,
                asset: oldLien.asset,
                tokenId: oldLien.tokenId,
                amount: oldLien.amount,
                assetType: oldLien.assetType,
                released: false
            });
            oldLien.released = true;
            // #576 Codex P3 — zero the old per-loan amount on retag, matching
            // `releaseCollateralLien`'s tombstone discipline. The aggregate is
            // deliberately NOT decremented here (the collateral physically
            // stays put and is now counted under `newLoanId`'s live lien), but
            // a released row with a stale non-zero `amount` would let an
            // old-loan reader (e.g. `MetricsFacet.getLoanCollateralLien`)
            // mis-report the full collateral as still liened against the
            // refinanced-away loan. The `released` flag is the source of truth;
            // zeroing `amount` removes the footgun.
            oldLien.amount = 0;
            return true;
        }
        // !sameKey — the old lien's key no longer matches the new loan (e.g.
        // the target obligation migrated to a different borrower since the
        // carry-over offer was created). Do NOT fall back to release+create:
        // the carry-over offer deposited no fresh collateral, so that would
        // leave the replacement loan backed by an accounting-only lien against
        // an empty vault. Signal the mismatch; the caller rejects the refinance.
        return false;
    }

    // ─── Offer-principal lock — per-offer (ERC20 Lender only) ───────────

    /// @notice Create an offer-principal lock at offer-create time.
    ///         Only ERC20 Lender offers reach this path — call sites
    ///         (in `OfferCreateFacet._pullCreatorAssetsClassic`)
    ///         already gate on `offerType == Lender && assetType == ERC20`.
    function createOfferPrincipalLien(
        uint256 offerId,
        address creator,
        address lendingAsset,
        uint256 amount
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.offerPrincipalLien[offerId];
        if (lien.user != address(0) && !lien.released) {
            revert EncumbranceAlreadyExists(offerId);
        }

        s.offerPrincipalLien[offerId] = LibVaipakam.Encumbrance({
            user: creator,
            asset: lendingAsset,
            tokenId: 0,
            amount: amount,
            assetType: LibVaipakam.AssetType.ERC20,
            released: false
        });
        s.encumbered[creator][lendingAsset][0] += amount;
    }

    /// @notice Decrement the offer-principal lock by `consumed` — used
    ///         on each `OfferMatchFacet.matchOffers` partial-fill
    ///         where the matched lender amount flows out of the
    ///         creator's vault.
    function decrementOfferPrincipalLien(
        uint256 offerId,
        uint256 consumed
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.offerPrincipalLien[offerId];
        if (lien.released || lien.user == address(0)) return;
        if (consumed > lien.amount) {
            // Defensive — the matcher's accounting shouldn't ever
            // overshoot, but if it does, fail loud so we can spot
            // the drift in tests rather than silently saturate.
            revert EncumbranceUnderflow(
                lien.user,
                lien.asset,
                lien.tokenId,
                consumed,
                lien.amount
            );
        }
        _decrementAggregate(lien.user, lien.asset, lien.tokenId, consumed);
        unchecked {
            lien.amount -= consumed;
        }
    }

    /// @notice Grow the offer-principal lock by `added` — used when a
    ///         lender raises an unaccepted offer's `amountMax` via
    ///         `OfferMutateFacet.setOfferAmount` / `modifyOffer`, which
    ///         pulls the extra principal into the creator's vault. The
    ///         lock must grow in lock-step so the new principal is
    ///         protected by the withdraw chokepoint. No-op on an
    ///         absent / already-released row (defensive — the mutate
    ///         path only reaches here for a live ERC20 lender offer that
    ///         already carries a lock from offer-create).
    function incrementOfferPrincipalLien(
        uint256 offerId,
        uint256 added
    ) internal {
        if (added == 0) return;
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.offerPrincipalLien[offerId];
        if (lien.released || lien.user == address(0)) return;
        s.encumbered[lien.user][lien.asset][lien.tokenId] += added;
        lien.amount += added;
    }

    /// @notice Release the offer-principal lock in full. Used on
    ///         cancel / single-fill accept / dust-close / lazy-expiry.
    ///         Idempotent (already-released rows are no-ops).
    function releaseOfferPrincipalLien(uint256 offerId) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.offerPrincipalLien[offerId];
        if (lien.released || lien.user == address(0)) return;
        if (lien.amount > 0) {
            _decrementAggregate(lien.user, lien.asset, lien.tokenId, lien.amount);
        }
        lien.released = true;
    }

    // ─── Read helpers ───────────────────────────────────────────────────

    /// @notice Free balance per the aggregate: caller-supplied raw
    ///         balance minus the active liens on `(user, asset,
    ///         tokenId)`. Used by `VaultFactoryFacet.vaultWithdrawERC20`'s
    ///         withdraw guard.
    function freeBalance(
        address user,
        address asset,
        uint256 tokenId,
        uint256 rawBalance
    ) internal view returns (uint256) {
        uint256 enc = LibVaipakam.storageSlot().encumbered[user][asset][tokenId];
        return rawBalance > enc ? rawBalance - enc : 0;
    }

    // ─── Internal ──────────────────────────────────────────────────────

    /// @dev Encodes the lien's `(asset, tokenId, amount)` from an
    ///      ERC-20 LOAN's collateral. NFT-rental loans never reach here
    ///      (D-1 gates them out in `createCollateralLien`), so there is
    ///      no prepay-pool branch — the lien is always the actual
    ///      pledged collateral.
    function _encodeCollateralFields(
        LibVaipakam.Loan storage loan
    )
        private
        view
        returns (address asset, uint256 tokenId, uint256 amount)
    {
        asset = loan.collateralAsset;
        if (loan.collateralAssetType == LibVaipakam.AssetType.ERC20) {
            tokenId = 0;
            amount = loan.collateralAmount;
        } else if (loan.collateralAssetType == LibVaipakam.AssetType.ERC721) {
            tokenId = loan.collateralTokenId;
            amount = 1;
        } else {
            // ERC1155
            tokenId = loan.collateralTokenId;
            amount = loan.collateralQuantity;
        }
    }

    function _decrementAggregate(
        address user,
        address asset,
        uint256 tokenId,
        uint256 amount
    ) private {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 cur = s.encumbered[user][asset][tokenId];
        if (amount > cur) {
            revert EncumbranceUnderflow(user, asset, tokenId, amount, cur);
        }
        unchecked {
            s.encumbered[user][asset][tokenId] = cur - amount;
        }
    }

    // ─── #594 — consolidation lien re-key (cross-user) ──────────────────

    /// @notice #594 — re-key a loan's SIDE-SPECIFIC encumbrance from the stored
    ///         owner to the current position-NFT holder (`newUser`), used when a
    ///         transferred position is consolidated into the holder's vault.
    /// @dev    The lien differs by side (design D-3 / §2 step 5):
    ///         - BORROWER: the per-loan collateral lien `loanCollateralLien`
    ///           (keyed under `loan.borrower`). Decrement the old user's
    ///           `encumbered` bucket, increment the new user's by the same
    ///           amount, rewrite `lien.user`.
    ///         - LENDER: the held-for-lender proceeds reservation
    ///           (`lenderProceedsEncumbered`, keyed under `loan.lender`), and
    ///           ONLY when one exists. It is usually ABSENT on an active lender
    ///           transfer (principal already disbursed, no terminal proceeds
    ///           reserved yet), so this MUST NOT assert a lien exists on the
    ///           lender side. It also MUST NOT touch `loanCollateralLien` for a
    ///           lender consolidation — re-keying the borrower's collateral lien
    ///           to the lender would underflow the lender's empty bucket.
    ///         The `encumbered` aggregate is conserved. Called by
    ///         {LibConsolidation} BEFORE the asset move so no ERC-721/1155
    ///         `onReceived` callback can observe an unlien'd destination vault.
    function rekeyLienToHolder(
        uint256 loanId,
        address newUser,
        bool isLenderSide
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (isLenderSide) {
            // #998 S10 Class B — migrate the DEDICATED active-held reservation too
            // (independent of the terminal `lenderProceedsEncumbered` ledger; both
            // can be live on one active loan — e.g. a preclose top-up plus a Class B
            // park). Reads the old lender internally, so it must run BEFORE the
            // caller re-anchors `loan.lender`; consolidation calls this at step 5,
            // before that reassignment.
            migrateActiveHeld(loanId, newUser);
            uint256 reserved = s.lenderProceedsEncumbered[loanId];
            if (reserved == 0) return; // no terminal reservation — active-held done above
            address oldLender = s.loans[loanId].lender;
            if (newUser == oldLender) return;
            address asset = s.lenderProceedsEncumberedAsset[loanId];
            // Move the aggregate from old lender → new lender; the per-loan
            // amount/asset record is loan-keyed and unchanged, so a later
            // `releaseLenderProceeds(loanId, loan.lender)` (now the holder)
            // decrements the right bucket.
            _decrementAggregate(oldLender, asset, 0, reserved);
            s.encumbered[newUser][asset][0] += reserved;
            return;
        }
        LibVaipakam.Encumbrance storage lien = s.loanCollateralLien[loanId];
        if (lien.released || lien.user == address(0)) return; // nothing to move
        address from = lien.user;
        if (from == newUser) return;
        _decrementAggregate(from, lien.asset, lien.tokenId, lien.amount);
        s.encumbered[newUser][lien.asset][lien.tokenId] += lien.amount;
        lien.user = newUser;
    }
}
