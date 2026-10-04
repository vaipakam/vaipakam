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
 * @title  ServiceCapacityFacet — #1219 (S-4): service capacity deposits (slices 1–3).
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
    ///         `amount` of the live VPFI, paying the arming fee the quote names
    ///         beside it ({previewArming}). Refused while the channel is dark,
    ///         while arming is dark (no positive fee rate, or no curve for the
    ///         role), while a bound term moved, and while the caller still holds
    ///         principal in a retired rotation epoch.
    /// @param  bind The terms the caller reviewed: the most fee they will pay, the
    ///         least capacity they expect afterwards, and the rotation and curve
    ///         epochs they quoted under — any that moved refuses by name.
    /// @return status 0 = posted; 1 = refused by a first authoritative sanctions flag (marker persisted, nothing moved).
    function postCapacityDeposit(uint8 role, uint256 amount, LibServiceCapacity.ArmingBind calldata bind)
        external
        nonReentrant
        whenNotPaused
        returns (uint8 status)
    {
        return LibServiceCapacity.post(LibVaipakam.storageSlot(), role, msg.sender, amount, bind);
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
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return LibServiceCapacity.withdraw(s, role, msg.sender, s.vpfiRotationEpoch, amount);
    }

    // ─── slice 3 — the arming fee and the rotation epochs ───

    /// @notice Withdraw the whole of the caller's `role` deposit in RETIRED
    ///         rotation `epoch`, paid in that epoch's own asset — the drain a
    ///         rotation asks of every operator before posting under the new token.
    ///         The first touch of a retired record announces it as archived. Same
    ///         sanctions rules as the live withdrawal.
    /// @return status 0 = paid; 2 = parked (nothing paid).
    /// @return paid   What left the escrow for the caller.
    function withdrawArchivedCapacityDeposit(uint8 role, uint64 epoch)
        external
        nonReentrant
        whenNotPaused
        returns (uint8 status, uint256 paid)
    {
        return LibServiceCapacity.withdrawArchived(LibVaipakam.storageSlot(), role, msg.sender, epoch);
    }

    /// @notice Set the arming fee rate (ADMIN; governance later): 1e18 = the whole
    ///         newly-armed principal; zero keeps arming DARK (posting refused); a
    ///         positive rate must sit at or above the positive floor.
    function setArmingFeeRate(uint256 rate) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibServiceCapacity.setArmingFeeRate(LibVaipakam.storageSlot(), rate);
    }

    /// @notice Raise the arming fee floor (ADMIN; raise-only, never back to zero,
    ///         never above the live rate — lift the rate first).
    function setArmingFeeFloor(uint256 floor) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibServiceCapacity.setArmingFeeFloor(LibVaipakam.storageSlot(), floor);
    }

    /// @notice The arming fee's shape: `rate` (0 = arming dark) over `floor`.
    function getArmingFee() external view returns (uint256 rate, uint256 floor) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.armingFeeRate, s.armingFeeFloor);
    }

    /// @notice The quote for posting `amount` into `operator`'s `role` deposit —
    ///         the SAME walk the post executes: the fee, the principal newly armed,
    ///         the capacity the deposit buys afterwards; `dark` when arming is.
    function previewArming(uint8 role, address operator, uint256 amount)
        external
        view
        returns (uint256 fee, uint256 granted, uint256 ceilingAfter, bool dark)
    {
        return LibServiceCapacity.armingQuote(LibVaipakam.storageSlot(), role, operator, amount);
    }

    /// @notice Whether rotation `epoch` was retired by a VPFI token rotation.
    function isRotationEpochArchived(uint64 epoch) external view returns (bool) {
        return LibVaipakam.storageSlot().rotationEpochArchived[epoch];
    }

    /// @notice Rotation `epoch`'s asset, the principal the escrow holds for it, and
    ///         whether it is retired. The live epoch's asset is the live VPFI token;
    ///         an epoch that never existed reads as zeros.
    function getServiceCapacityEscrowByEpoch(uint64 epoch) external view returns (address token, uint256 total, bool archived) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        archived = s.rotationEpochArchived[epoch];
        token = archived ? s.rotationEpochToken[epoch] : (epoch == s.vpfiRotationEpoch ? s.vpfiToken : address(0));
        total = s.serviceDepositEscrowByEpoch[epoch];
    }

    // ─── slice 2 — the limiter ───

    /// @notice Set `role`'s capacity curve (ADMIN; governance later). Every figure
    ///         positive and the free tier at least one action; bumps the curve
    ///         epoch, so every bucket resets at its next touch.
    function setCapacityCurve(uint8 role, uint256 freeTier, uint256 freeRatePerSec, uint256 bondAt4x, uint256 classCost)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibServiceCapacity.setCurve(LibVaipakam.storageSlot(), role, freeTier, freeRatePerSec, bondAt4x, classCost);
    }

    /// @notice The spend every charged route reaches by Diamond self-call
    ///         ({LibServiceCapacity.charge}): settle the actor's bucket and take the
    ///         cost of `units` executed items, or refuse by name. Gated to the
    ///         Diamond; the caller holds the reentrancy guard and the pause.
    function capacitySpendInternal(uint8 role, address actor, uint256 units, bool freeOnly) external {
        if (msg.sender != address(this)) revert RewardCustodyOnlyDiamondInternal(msg.sender);
        LibServiceCapacity.spend(LibVaipakam.storageSlot(), role, actor, units, freeOnly);
    }

    /// @notice Bind `adapter`'s fills to `operator` (ADMIN) — for adapters created
    ///         before the factory wrote the binding; the factory writes it at
    ///         creation for every new adapter.
    function setAdapterOperator(address adapter, address operator) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.storageSlot().adapterOperator[adapter] = operator;
        emit LibServiceCapacity.AdapterOperatorBound(adapter, operator);
    }

    /// @notice `role`'s curve; `freeTier == 0` means the role's limiter is dark (unset, or cleared by a token rotation).
    function getCapacityCurve(uint8 role) external view returns (LibVaipakam.CapacityCurve memory) {
        return LibVaipakam.storageSlot().capacityCurves[role];
    }

    /// @notice `actor`'s stored `role` bucket (the raw record; see {previewCapacity} for the settled figure).
    function getCapacityBucket(uint8 role, address actor) external view returns (LibVaipakam.CapacityBucket memory) {
        return LibVaipakam.storageSlot().capacityBuckets[role][actor];
    }

    /// @notice What `actor`'s `role` bucket holds now, and the rate and ceiling
    ///         the actor's current deposit buys; `dark` when the role's curve is unset.
    function previewCapacity(uint8 role, address actor)
        external
        view
        returns (uint256 accrued, uint256 rate, uint256 ceiling, bool dark)
    {
        return LibServiceCapacity.accruedNow(LibVaipakam.storageSlot(), role, actor);
    }

    /// @notice The operator `adapter`'s fills are charged to (zero = unbound).
    function getAdapterOperator(address adapter) external view returns (address) {
        return LibVaipakam.storageSlot().adapterOperator[adapter];
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
