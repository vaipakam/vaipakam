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

    /// @notice Re-key a collateral lien from one loan id to another.
    ///         Used on `RefinanceFacet.refinanceLoan` (and any future
    ///         obligation-transfer path) when the old loan closes +
    ///         the new loan inherits the same collateral identity.
    ///         The lien stays on the same `(user, asset, tokenId)`
    ///         tuple → the aggregate does NOT change.
    function rekeyCollateralLienOnRefinance(
        uint256 oldLoanId,
        uint256 newLoanId,
        LibVaipakam.Loan storage newLoan
    ) internal {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage oldLien = s.loanCollateralLien[oldLoanId];
        if (oldLien.released || oldLien.user == address(0)) return;

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
        } else {
            // Different collateral identity → release old + create
            // fresh (aggregate ticks under both keys).
            releaseCollateralLien(oldLoanId);
            createCollateralLien(newLoanId, newLoan);
        }
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
}
