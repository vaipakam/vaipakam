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
    /// @dev    Created for ALL loan shapes — ERC20 collateral AND
    ///         NFT-rental prepay+buffer pools. The rental case looks
    ///         like a pool that should "flow out", but the legitimate
    ///         rental drains (daily deduction, partial repay, lender
    ///         claim) are wired through {decrementCollateralLien} so
    ///         the lien stays in parity with the loan's remaining
    ///         collateral throughout. This shields the pool from
    ///         unrelated ERC20-withdraw surfaces such as
    ///         `VPFIDiscountFacet.withdrawVPFIFromVault` when
    ///         `prepayAsset == VPFI`. #407 PR 4 round-1 Codex P1 #4
    ///         (2026-06-12) — earlier "skip lien for NFT rentals"
    ///         shortcut was wrong precisely because of that surface.
    function createCollateralLien(
        uint256 loanId,
        LibVaipakam.Loan storage loan
    ) internal {
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
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.Encumbrance storage lien = s.loanCollateralLien[loanId];
        if (added == 0) return;
        // Defensive — caller should only invoke this on an active loan
        // with a live lien. If the lien is missing (e.g. a future
        // active-during-recreate race), recreate it inline so the
        // top-up is still protected.
        if (lien.released || lien.user == address(0)) {
            revert EncumbranceUnderflow(
                lien.user,
                lien.asset,
                lien.tokenId,
                added,
                0
            );
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

    function _encodeCollateralFields(
        LibVaipakam.Loan storage loan
    )
        private
        view
        returns (address asset, uint256 tokenId, uint256 amount)
    {
        // For NFT-rental loans the borrower's vault holds `prepayAmount
        // + bufferAmount` of the prepay asset — NOT `collateralAmount`
        // (which is a lender-quoted reference figure from the offer and
        // is typically much larger than the actual escrow). Locking
        // `collateralAmount` would block every legitimate rental flow
        // because the lien would exceed the vault balance from day 1.
        // ERC20 loans use `collateralAmount` directly since it equals
        // the deposit. #407 PR 4 round-1 (2026-06-12).
        if (loan.assetType != LibVaipakam.AssetType.ERC20) {
            asset = loan.prepayAsset;
            tokenId = 0;
            amount = loan.prepayAmount + loan.bufferAmount;
            return (asset, tokenId, amount);
        }
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
