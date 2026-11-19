// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibEncumbrance} from "../libraries/LibEncumbrance.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";

/**
 * @title  CollateralLienFacet
 * @author Vaipakam Developer Team
 * @notice The cross-facet entries that change a loan's collateral lien:
 *         release, decrement, increment and re-create. Each lien change also
 *         moves the platform-wide pledged total of the collateral asset
 *         (#3685), which {CollateralConcentrationFacet} reads.
 * @dev    Split off `EncumbranceMutateFacet` in #3685, along the lien /
 *         close-out seam: that facet had run out of EIP-170 room once the
 *         pledged total joined each lien change. Same storage, same Diamond,
 *         same selectors; only the runtime bytecode moved. Callers reach these
 *         entries by `LibFacet.crossFacetCall`, so the lien bookkeeping lives
 *         here and not in the caller's bytecode. Every entry is gated to
 *         `msg.sender == address(this)`. LibEncumbrance stays the ONE writer
 *         of liens and of the pledged total; this facet only hosts it.
 */
contract CollateralLienFacet {
    /// @notice A caller other than the Diamond itself.
    error OnlyDiamondInternal();

    modifier onlyDiamondInternal() {
        if (msg.sender != address(this)) revert OnlyDiamondInternal();
        _;
    }

    /// @notice Release a loan's collateral lien in full. Idempotent
    ///         (already-released or empty rows are no-ops). See
    ///         {LibEncumbrance.releaseCollateralLien}.
    function releaseCollateralLien(uint256 loanId) external onlyDiamondInternal {
        LibEncumbrance.releaseCollateralLien(loanId);
    }

    /// @notice Decrement an active lien by `consumed` (a partial liquidation
    ///         slice, a periodic shortfall sale, a rental deduction, a partial
    ///         withdrawal). See {LibEncumbrance.decrementCollateralLien}.
    function decrementCollateralLien(uint256 loanId, uint256 consumed) external onlyDiamondInternal {
        LibEncumbrance.decrementCollateralLien(loanId, consumed);
    }

    /// @notice Increment the lien by `added` (a collateral top-up, or fallback
    ///         entry re-liening the custody). See
    ///         {LibEncumbrance.incrementCollateralLien}.
    function incrementCollateralLien(uint256 loanId, uint256 added) external onlyDiamondInternal {
        LibEncumbrance.incrementCollateralLien(loanId, added);
    }

    /// @notice Re-create the lien from the loan row's current borrower and
    ///         collateral: the create leg of an obligation handover. No-op on
    ///         NFT-rental loans. See {LibEncumbrance.recreateCollateralLien}.
    function recreateCollateralLien(uint256 loanId) external onlyDiamondInternal {
        LibEncumbrance.recreateCollateralLien(loanId, LibVaipakam.storageSlot().loans[loanId]);
    }
}
