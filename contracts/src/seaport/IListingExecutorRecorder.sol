// src/seaport/IListingExecutorRecorder.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IListingExecutorRecorder
 * @author Vaipakam Developer Team
 * @notice T-086 step 6: the diamond-facing surface of
 *         {CollateralListingExecutor} that {NFTPrepayListingFacet}
 *         calls into when borrowers post / update / cancel
 *         prepay-collateral listings.
 *
 *         Three responsibilities the interface narrows the executor's
 *         API down to (so the borrower-facing facet's audit surface
 *         lists exactly the executor entry points it depends on):
 *
 *           1. **`recordOrder(orderHash, loanId, conduit)`** — pin a
 *              Seaport `orderHash → (loanId, conduit)` binding on
 *              the executor before Seaport processes a signed
 *              order. Diamond-gated on the executor side
 *              (`msg.sender == vaipakamDiamond`); the listing facet
 *              is the ONLY surface that legitimately calls it.
 *
 *           2. **`clearOrder(orderHash)`** — remove the binding so a
 *              previously-signed order can no longer fill. Called on
 *              borrower cancel, on the permissionless grace-expired
 *              cancel, and as the first leg of an update (clear the
 *              old hash before recording the new one). Idempotent on
 *              the executor side.
 *
 *           3. **`approvedConduits(conduit)`** — view-only allow-list
 *              membership check. The facet uses it to fail-fast at
 *              `postPrepayListing` time with a meaningful error
 *              (`ConduitNotApproved`) instead of bouncing through
 *              `recordOrder`'s revert — gives the caller a clean
 *              precondition signal.
 *
 * @dev    Defined in `contracts/src/seaport/` next to the executor
 *         it abstracts, matching the existing convention of
 *         {IVaipakamPrepayContext} (diamond view surface) and
 *         {IVaipakamPrepayCallbacks} (executor → diamond callback).
 *         This file adds the third direction: diamond → executor
 *         order-record surface.
 */
interface IListingExecutorRecorder {
    /// @notice Pin a Seaport `orderHash → (loanId, conduit)` binding.
    ///         See {CollateralListingExecutor.recordOrder}.
    function recordOrder(bytes32 orderHash, uint256 loanId, address conduit) external;

    /// @notice Remove a binding. Idempotent.
    ///         See {CollateralListingExecutor.clearOrder}.
    function clearOrder(bytes32 orderHash) external;

    /// @notice Allow-list membership for `conduit`.
    function approvedConduits(address conduit) external view returns (bool);
}
