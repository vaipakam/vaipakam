// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibRewardCustody} from "../libraries/LibRewardCustody.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  RewardEraFacet — slice 4 PR C (#1566): the custody era registry's
 *         reads, its two attribution writers and the era routing of a
 *         packet's fresh.
 * @author Vaipakam Developer Team
 * @notice A chain's reward role lives in ERAS: a role change retires the live
 *         era, carrying the live-fresh custody into the retiring era's row,
 *         and opens the next. This facet reads the registry; hosts the two
 *         writers that move value OUT of a retired era — the release once the
 *         era is final (into the live baseline under the deficit split, or
 *         into PENDING SURPLUS while Detached) and the pending-surplus drain
 *         (once an active era exists); and hosts the ONE rule that routes a
 *         packet's fresh to the era the packet belongs to.
 *         Nothing here waits on a manual step (#1566 PR C revision): an era is
 *         final on the per-day closure proof alone — which anyone may run —
 *         with nothing staged on its row.
 * @dev    Its own facet because the facets that would host it are out of
 *         EIP-170 headroom; the routing is reached from them by Diamond-
 *         internal self-call. The carry-forward itself is library code inlined
 *         into {RewardReporterFacet}, which owns the role setters.
 *
 *         NOT `whenNotPaused`, matching {RewardEpochFacet}: nothing here pays
 *         anybody, and a pause must not stall an era's close-out.
 */
contract RewardEraFacet is DiamondReentrancyGuard, DiamondAccessControl, IVaipakamErrors {
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

    /// @notice Writer 2 of 3 — finalize a RETIRED era and release its holder row:
    ///         to the live baseline under the §5c deficit split on an active
    ///         role, into PENDING SURPLUS while Detached. Permissionless. Refuses
    ///         by name: the live era, an unknown era, one already finalized, and
    ///         one with a day of its span not yet proven closed or a staging hold
    ///         on its row.
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

    /// @notice #1566 PR C revision — credit a packet's fresh, now in row `from`, to
    ///         the packet's era (Diamond-internal: the classification). The rule
    ///         is {LibRewardCustody.creditFreshToEraFromRow}.
    function eraCreditFreshFromRow(uint8 from, uint256 amount, uint64 era)
        external
        returns (uint256 toLive, uint256 toRestitution)
    {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        return LibRewardCustody.creditFreshToEraFromRow(
            LibVaipakam.storageSlot(), LibVaipakam.RewardCustodyRow(from), amount, era
        );
    }

    /// @notice #1566 PR C revision — a fresh inflow for era `era` (Diamond-internal:
    ///         the compensation credit). The rule is {LibRewardCustody.relocateFreshIngressToEra}.
    function eraRelocateFreshIngress(uint256 amount, uint64 era) external {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        LibRewardCustody.relocateFreshIngressToEra(LibVaipakam.storageSlot(), amount, era);
    }

    /// @notice #1566 PR C revision — a demotion of packet `h`'s credit, taken back
    ///         from where it went (Diamond-internal: the compensation demotion).
    ///         The rule is {LibRewardCustody.uncreditFreshForPacket}.
    function eraUncreditFresh(bytes32 h, uint256 amount) external returns (uint256 moved) {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        return LibRewardCustody.uncreditFreshForPacket(LibVaipakam.storageSlot(), h, amount);
    }

    /// @notice PR C-4 — one parked legacy broadcast's record.
    function getParkedBroadcast(uint256 id) external view returns (LibVaipakam.ParkedBroadcast memory) {
        return LibVaipakam.storageSlot().parkedBroadcasts[id];
    }

    /// @notice PR C-4 — how many parked broadcasts era `era` still carries open.
    ///         Informational: an era's finality does not wait on them.
    function getCustodyEraParkedOpen(uint64 era) external view returns (uint256) {
        return LibVaipakam.storageSlot().custodyEraParkedOpen[era];
    }

    /// @notice PR C-4 — the operator's recorded disposition of a parked broadcast
    ///         the gate refuses: it leaves its era's open count with `reason`.
    ///         Optional: nothing waits on it — a parked copy of a closed day's
    ///         broadcast installs nothing that prices an obligation.
    function tombstoneParkedBroadcast(uint256 id, bytes32 reason) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibRewardCustody.tombstoneParkedBroadcast(LibVaipakam.storageSlot(), id, reason);
    }
}
