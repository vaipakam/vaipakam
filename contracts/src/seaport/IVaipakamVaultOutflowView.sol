// src/seaport/IVaipakamVaultOutflowView.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IVaipakamVaultOutflowView
 * @author Vaipakam Developer Team
 * @notice #3178 — the call shape `CollateralListingExecutor` uses to ask the
 *         Diamond whether a parallel-sale listing's vault may still send its
 *         collateral out (`OfferParallelSaleFacet.isParallelSaleVaultBlocked`).
 * @dev    Standalone, like `IVaipakamSanctionsView`: no facet implements it by
 *         inheritance, and the Diamond routes the selector to the facet.
 */
interface IVaipakamVaultOutflowView {
    /// @notice True when the vault holding `offerId`'s listed collateral is
    ///         below the mandatory vault version, so nothing may leave it on
    ///         its owner's own listing until the owner upgrades.
    function isParallelSaleVaultBlocked(uint256 offerId) external view returns (bool);
}
