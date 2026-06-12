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
 *              `LoanFacet.initiateLoan`; released on every loan-
 *              lifecycle terminal that frees the collateral
 *              (`RepayFacet.repayLoan`, `PrecloseFacet.precloseDirect`,
 *              `ClaimFacet`, `DefaultedFacet.triggerDefault`,
 *              `RefinanceFacet.refinanceLoan`).
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
    /// @dev    #407 PR 4 (T-407-B, 2026-06-12) — gated to ERC20 LOANS
    ///         only. NFT-rental loans (`loan.assetType` is ERC721 or
    ///         ERC1155) use the borrower's escrowed prepay+buffer pool
    ///         as `collateralAsset`, and the rental flow is DESIGNED to
    ///         drain that pool continuously through {RepayFacet}'s
    ///         daily-deduction + partial-repay paths. Locking it would
    ///         block those legitimate flows; the lender's claim on the
    ///         pool is already protected by the structured rental math
    ///         (`heldForLender`, `protocolTrackedVaultBalance`,
    ///         `bufferAmount`) — the sub-ledger lien adds nothing
    ///         there.  See
    ///         `docs/DesignsAndPlans/PerLoanCollateralLien.md` §3.5.
    function createCollateralLien(
        uint256 loanId,
        LibVaipakam.Loan storage loan
    ) internal {
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
