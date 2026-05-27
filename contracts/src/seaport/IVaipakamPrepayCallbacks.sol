// src/seaport/IVaipakamPrepayCallbacks.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IVaipakamPrepayCallbacks
 * @notice Minimal interface the `CollateralListingExecutor` calls back
 *         into the Vaipakam diamond with at Seaport fill time. The
 *         diamond hosts the implementation on a privileged facet method
 *         that asserts `msg.sender == collateralListingExecutor` before
 *         touching loan state.
 *
 * @dev   T-086 step 5 partitions the executor↔diamond responsibility
 *         this way:
 *           - Executor verifies the Seaport order satisfies the live
 *             floor + recipient invariants at fill time (so a paused
 *             diamond can't accept a stale-signature theft).
 *           - Diamond owns `loans[loanId].status` mutation,
 *             `LibERC721._unlock(borrowerNftId)` invocation, and the
 *             load-bearing `LibVPFIDiscount.settleBorrowerLifProper`
 *             call — anything that touches diamond storage stays in
 *             the diamond.
 *
 *         The diamond-side method is added in step 5 alongside this
 *         executor; step 6 wires the borrower-facing entry points
 *         (`postPrepayListing` etc) that PRODUCE the orders the
 *         executor later signs + finalizes.
 */
interface IVaipakamPrepayCallbacks {
    /// @notice Finalize a Seaport prepay-listing fill. Marks the loan
    ///         Settled, unlocks the borrower NFT, and calls
    ///         `LibVPFIDiscount.settleBorrowerLifProper` so the
    ///         borrower's VPFI rebate (Phase-5 LIF) accrues correctly
    ///         on this proper-close path.
    /// @dev    The diamond's implementation MUST assert:
    ///           - `msg.sender == collateralListingExecutor` (the
    ///             diamond's stored executor address — only this
    ///             singleton can finalize).
    ///           - `loan.status == LoanStatus.Active` (re-validates
    ///             the executor's own check; defense-in-depth).
    ///         and then atomically:
    ///           - `loan.status = LoanStatus.Settled` via LibLifecycle.
    ///           - `LibERC721._unlock(loan.borrowerTokenId)`.
    ///           - `LibVPFIDiscount.settleBorrowerLifProper(loan)`.
    function executorFinalizePrepaySale(uint256 loanId) external;
}
