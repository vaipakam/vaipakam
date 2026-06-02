// src/seaport/IListingExecutorRecorder.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {FeeLeg} from "./PrepayTypes.sol";

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
 *           1. **`recordOrder(orderHash, loanId, conduit, conduitKey,
 *              salt, startTime, askPrice)`** — pin a Seaport
 *              `orderHash → (loanId, conduit, …)` binding on the
 *              executor before Seaport processes a signed order.
 *              Diamond-gated on the executor side
 *              (`msg.sender == vaipakamDiamond`); the listing facet
 *              is the ONLY surface that legitimately calls it.
 *              T-086 #316 extended the recorded shape so the
 *              executor can rebuild the canonical `OrderComponents`
 *              at cleanup time without re-fetching from the diamond.
 *
 *           2. **`clearOrder(orderHash)`** — remove the binding so a
 *              previously-signed order can no longer fill. Called on
 *              borrower cancel, on the permissionless grace-expired
 *              cancel, and as the first leg of an update (clear the
 *              old hash before recording the new one). Idempotent on
 *              the executor side. T-086 #316 extended this surface
 *              to ALSO forward `Seaport.cancel` for the matching
 *              orderHash (best-effort) so OpenSea's catalog refreshes
 *              within ~30s.
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
    /// @notice Pin a Seaport `orderHash → (loanId, conduit, …, feeLegs)`
    ///         binding. T-086 #316 extended the recorded shape with
    ///         `conduitKey`, `salt`, `startTime`, and `askPrice` so
    ///         the executor can rebuild the canonical `OrderComponents`
    ///         at cleanup time (used to forward `Seaport.cancel` for
    ///         fast OpenSea catalog refresh). T-086 Round-5 / #313
    ///         (Block A) additionally records the full `FeeLeg[]`
    ///         array so the same cancel-time reconstruction works
    ///         for fee-enforced collections — the fee legs cannot be
    ///         derived from the orderHash alone (Seaport's
    ///         `getOrderHash` is a one-way digest), so the recorder
    ///         is the only place this data can live before cleanup.
    ///         See {CollateralListingExecutor.recordOrder}.
    function recordOrder(
        bytes32 orderHash,
        uint256 loanId,
        address conduit,
        bytes32 conduitKey,
        uint256 salt,
        uint256 startTime,
        uint256 askPrice,
        FeeLeg[] calldata feeLegs
    ) external;

    /// @notice Remove a binding. Idempotent. T-086 #316: while the
    ///         binding still exists, the executor reconstructs the
    ///         canonical `OrderComponents` and forwards
    ///         `Seaport.cancel` so OpenSea's marketplace catalog
    ///         refreshes the listing within ~30s of the cleanup.
    ///         The cancel emit is best-effort; reconstruction
    ///         mismatch (NFT-holder transfer, counter increment,
    ///         treasury rotation) gracefully falls back to no-op.
    ///         See {CollateralListingExecutor.clearOrder}.
    function clearOrder(bytes32 orderHash) external;

    /// @notice Allow-list membership for `conduit`.
    function approvedConduits(address conduit) external view returns (bool);
}
