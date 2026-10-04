// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibServiceCapacity} from "../libraries/LibServiceCapacity.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {RewardCustodyHolder} from "../RewardCustodyHolder.sol";

/**
 * @title  ServiceCapacityFacet — #1219 (S-4): service capacity deposits, slice 1.
 * @author Vaipakam Developer Team
 * @notice The operator-facing surface of the capacity deposit: post or raise,
 *         withdraw immediately, read the record; the admin binds the escrow
 *         holder once and holds the channel's switch. DARK by default — the
 *         switch is off, posting is refused, withdrawals and the free tier
 *         stand — because VPFI is earn-only at launch and a required deposit
 *         would make the gated roles unreachable (owner, 2026-08-03).
 * @dev    Its own facet: the deposit is a new custody class with its own
 *         holder, and no reward facet has the headroom. Value-moving selectors
 *         carry the reentrancy guard and the pause; the sanctions screen is per
 *         selector and registry-aware (see {LibServiceCapacity}). Statuses are
 *         RETURNED for the committed first-flag refusals so an integrating
 *         contract can branch on them.
 */
contract ServiceCapacityFacet is DiamondReentrancyGuard, DiamondPausable, DiamondAccessControl, IVaipakamErrors {
    /// @notice Bind the deposit escrow holder, once: a `RewardCustodyHolder`
    ///         instance of its own, moving tokens only at this Diamond's
    ///         instruction. Never the reward holder.
    function bindServiceCapacityEscrow() external onlyRole(LibAccessControl.ADMIN_ROLE) returns (address escrow) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.serviceCapacityEscrow != address(0)) revert ServiceCapacityEscrowAlreadyBound();
        escrow = address(new RewardCustodyHolder(address(this)));
        s.serviceCapacityEscrow = escrow;
        emit LibServiceCapacity.ServiceCapacityEscrowBound(escrow);
    }

    /// @notice The channel's switch (admin now; owner intent is governance-held
    ///         later, so this expects to sit behind the timelock). Enablement is
    ///         a deliberate later act gated on VPFI being widely enough
    ///         distributed — an economic precondition recorded in the runbook.
    function setServiceCapacityEnabled(bool enabled) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.storageSlot().serviceCapacityEnabled = enabled;
        emit LibServiceCapacity.ServiceCapacityEnabledSet(enabled);
    }

    /// @notice Post (or raise) the caller's capacity deposit for `role` by
    ///         `amount` of the live VPFI. Refused while the channel is dark.
    /// @return status 0 = posted; 1 = refused by a first authoritative sanctions flag (marker persisted, nothing moved).
    function postCapacityDeposit(uint8 role, uint256 amount) external nonReentrant whenNotPaused returns (uint8 status) {
        return LibServiceCapacity.post(LibVaipakam.storageSlot(), role, msg.sender, amount);
    }

    /// @notice Withdraw `amount` of the caller's deposit for `role`, immediately
    ///         — dark or not. A first authoritative sanctions flag parks the
    ///         request instead; a later clean read releases the parked cap.
    /// @return status 0 = paid; 2 = parked (nothing paid).
    /// @return paid   What left the escrow for the caller.
    function withdrawCapacityDeposit(uint8 role, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        returns (uint8 status, uint256 paid)
    {
        return LibServiceCapacity.withdraw(LibVaipakam.storageSlot(), role, msg.sender, amount);
    }

    /// @notice Whether the channel is enabled.
    function isServiceCapacityEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().serviceCapacityEnabled;
    }

    /// @notice One deposit record. Reads as zeros when none exists.
    function getCapacityDeposit(uint8 role, address operator, uint64 rotationEpoch)
        external
        view
        returns (LibVaipakam.ServiceCapacityDeposit memory)
    {
        return LibVaipakam.storageSlot().serviceDeposits[role][operator][rotationEpoch];
    }

    /// @notice The escrow holder, the live rotation epoch, and the principal the
    ///         escrow holds for that epoch — the fourth tracked VPFI balance class.
    function getServiceCapacityEscrow() external view returns (address escrow, uint64 rotationEpoch, uint256 liveEpochTotal) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        escrow = s.serviceCapacityEscrow;
        rotationEpoch = s.vpfiRotationEpoch;
        liveEpochTotal = s.serviceDepositEscrowByEpoch[rotationEpoch];
    }
}
