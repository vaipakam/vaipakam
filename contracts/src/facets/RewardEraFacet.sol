// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardEraFacet — slice 4 PR C-1 (#1566): the custody era registry's
 *         reads and its two attribution writers.
 * @author Vaipakam Developer Team
 * @notice A chain's reward role lives in ERAS: a role change retires the live
 *         era, carrying the live-fresh custody into the retiring era's row,
 *         and opens the next. This facet reads the registry and hosts the two
 *         writers that move value OUT of a retired era — the terminal release
 *         (into the live baseline under the deficit split, or into PENDING
 *         SURPLUS while Detached) and the pending-surplus drain (once an active
 *         era exists). Both are deterministic bookkeeping over custody the
 *         holder already holds, so both are permissionless; both are DARK until
 *         the backfill (PR C-5) has assigned history to eras.
 * @dev    Its own facet because the two facets that would host it are out of
 *         EIP-170 headroom ({RewardCustodyFacet} ~1.1 KB, {RewardReconciliationFacet}
 *         ~0.8 KB). The carry-forward itself is library code inlined into
 *         {RewardReporterFacet}, which owns the role setters.
 *
 *         NOT `whenNotPaused`, matching {RewardEpochFacet}: nothing here pays
 *         anybody, and the migration pause must not stall an era's close-out.
 */
contract RewardEraFacet is DiamondReentrancyGuard, IVaipakamErrors {
    /// @notice The live era's id.
    function getCustodyEraCurrent() external view returns (uint64) {
        return LibVaipakam.storageSlot().custodyEraCurrent;
    }

    /// @notice One era's record. Reads as zeros for an era above the live one.
    function getCustodyEra(uint64 era) external view returns (LibVaipakam.CustodyEra memory) {
        return LibVaipakam.storageSlot().custodyEras[era];
    }

    /// @notice Σ of every retired era's holder row — the registry's share of the attributed total.
    function getCustodyEraRowsTotal() external view returns (uint256) {
        return LibVaipakam.storageSlot().custodyEraRowsTotal;
    }

    /// @notice Whether the backfill (PR C-5) has assigned history to eras; the writers below are dark until it has.
    function isCustodyEraBackfillComplete() external view returns (bool) {
        return LibVaipakam.storageSlot().custodyEraBackfillComplete;
    }

    /// @notice Writer 2 of 3 — finalize a RETIRED era whose counters read zero
    ///         and release its holder row: to the live baseline under the §5c
    ///         deficit split on an active role, into PENDING SURPLUS while
    ///         Detached. Refuses by name: the live era, an unknown era, one
    ///         already finalized, one still carrying obligations, and every
    ///         era until the backfill has run.
    /// @return released          What left the era's row.
    /// @return toPendingSurplus  Whether it went to PENDING SURPLUS (Detached) rather than the live baseline.
    function finalizeCustodyEra(uint64 era) external nonReentrant returns (uint256 released, bool toPendingSurplus) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return LibRewardCustody.finalizeCustodyEra(s, era, LibVaipakam.rewardRole(s));
    }

    /// @notice Writer 3 of 3 — credit `amount` of PENDING SURPLUS to the live
    ///         baseline under the deficit split. Needs an ACTIVE role: while
    ///         Detached the surplus has no era to serve and stays where it is.
    function drainPendingSurplus(uint256 amount) external nonReentrant {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        LibVaipakam.RewardRole role = LibVaipakam.rewardRole(s);
        if (role != LibVaipakam.RewardRole.Canonical && role != LibVaipakam.RewardRole.Mirror) {
            revert CustodyPendingSurplusNeedsActiveRole(uint8(role));
        }
        LibRewardCustody.drainPendingSurplus(s, amount);
    }

    /// @notice PR C-2 — what era `era`'s row can fund of `need` for one day: the
    ///         view the pricing primitive reads after the transport allocation.
    function getCustodyEraAllocationForDay(uint64 era, uint256 need) external view returns (uint256) {
        uint256 room = LibRewardCustody.custodyEraRoom(LibVaipakam.storageSlot(), era);
        return need < room ? need : room;
    }

    /// @notice PR C-2 — fund day `dayId` from era `era` (Diamond-internal: the
    ///         walk's per-day settle seam). The rule is {LibRewardCustody.drawCustodyEraForDay}.
    function eraDrawForDay(uint64 era, uint256 dayId, uint256 amount) external {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        LibRewardCustody.drawCustodyEraForDay(LibVaipakam.storageSlot(), era, dayId, amount);
    }
}
