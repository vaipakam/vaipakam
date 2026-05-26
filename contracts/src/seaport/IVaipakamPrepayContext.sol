// src/seaport/IVaipakamPrepayContext.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";

/**
 * @title IVaipakamPrepayContext
 * @notice Diamond view-facet interface the `CollateralListingExecutor`
 *         singleton calls to read loan state + pre-computed floor /
 *         grace / recipients in the DIAMOND'S storage context.
 *
 * @dev   This interface exists because the executor is a singleton
 *         contract, NOT a facet of the diamond. Libraries that read
 *         `LibVaipakam.storageSlot()` (`LibCollateralSettlement.liveFloor`,
 *         `LibVaipakam.gracePeriod`, the loan record itself) execute
 *         against the CALLER's storage context. When the executor
 *         invokes them, the storage slot resolves against the
 *         executor's own storage (empty / zero), so the "live floor"
 *         evaluates to 0 and any fill paying ≥ 0 passes. Codex P0 on
 *         PR #288 Round 1 caught this.
 *
 *         The fix is the executor reads everything via this ONE
 *         bundled view, which the diamond hosts on a `PrepayListingViewFacet`.
 *         All library calls happen inside the diamond's storage
 *         context where they belong. The executor uses the returned
 *         struct for every check — no library calls inside the
 *         executor's body.
 */
interface IVaipakamPrepayContext {
    /// @notice Aggregate context the executor needs to validate a Seaport
    ///         prepay-listing fill against a specific loan at a specific
    ///         timestamp.
    /// @dev    All fields read from the diamond's storage in ONE call.
    ///         The executor uses the values as-is — no further
    ///         computation against diamond storage is required.
    struct PrepayContext {
        // ── Loan-shape (immutable for the loan's lifetime) ──────────────
        LibVaipakam.LoanStatus status;
        LibVaipakam.AssetType assetType;
        LibVaipakam.AssetType collateralAssetType;
        address principalAsset;
        address collateralAsset;
        uint256 collateralTokenId;
        uint256 collateralQuantity;

        // ── Time-varying / governance-tunable values resolved as-of ────
        //    `asOfTimestamp`. The executor uses these as the live floor
        //    + grace + recipient bindings for the fill. Caller passes
        //    `block.timestamp` at fill time so the read is current.
        uint256 lenderLeg;       // LibCollateralSettlement.principalPlusAccruedInterest
        uint256 treasuryLeg;     // LibCollateralSettlement.treasuryAndPrecloseFee
        uint256 graceEnd;        // startTime + duration*1d + LibVaipakam.gracePeriod
        address lenderNftOwner;  // VaipakamNFTFacet.ownerOf(loan.lenderTokenId)
        address borrowerNftOwner;// VaipakamNFTFacet.ownerOf(loan.borrowerTokenId)
        address treasury;        // AdminFacet.getTreasury()
    }

    /// @notice Bundle every value the executor needs into a single view
    ///         call. Implementation on the diamond reads from
    ///         `LibVaipakam.storageSlot().loans[loanId]` + invokes
    ///         `LibCollateralSettlement.principalPlusAccruedInterest`
    ///         and `treasuryAndPrecloseFee` + reads `cfgTreasuryFeeBps`
    ///         + reads `treasury` + resolves the lender / borrower NFT
    ///         current holders. Pure read; no state mutation.
    /// @param  loanId         Loan to look up.
    /// @param  asOfTimestamp  The block timestamp to evaluate
    ///                        time-varying quantities at. Passed by the
    ///                        executor as `block.timestamp` at fill time.
    function getPrepayContext(uint256 loanId, uint256 asOfTimestamp)
        external
        view
        returns (PrepayContext memory);
}
