// src/facets/AdminFacet.sol (new file or extend OwnershipFacet)
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibPausable} from "../libraries/LibPausable.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title AdminFacet
 * @author Vaipakam Developer Team
 * @notice Role-restricted admin functions for configuration, including setting treasury and pause controls.
 * @dev Part of Diamond Standard. Uses LibAccessControl for role-based access.
 *      ADMIN_ROLE for configuration, PAUSER_ROLE for pause/unpause.
 */
contract AdminFacet is DiamondAccessControl, IVaipakamErrors {
    /// @dev Accepts either ADMIN_ROLE or PAUSER_ROLE. Used for per-asset
    ///      pause/unpause so incident response stays actionable once
    ///      ADMIN_ROLE is handed to a time-locked governance executor —
    ///      PAUSER_ROLE can remain a fast-key multisig.
    modifier onlyAdminOrPauser() {
        if (
            !LibAccessControl.hasRole(LibAccessControl.ADMIN_ROLE, msg.sender) &&
            !LibAccessControl.hasRole(LibAccessControl.PAUSER_ROLE, msg.sender)
        ) {
            revert LibAccessControl.AccessControlUnauthorizedAccount(
                msg.sender,
                LibAccessControl.PAUSER_ROLE
            );
        }
        _;
    }

    /// @notice Emitted when the protocol treasury address is updated.
    /// @param newTreasury The newly-set treasury address.
    event TreasurySet(address indexed newTreasury);

    /// @notice Emitted when the 0x proxy used for liquidation swaps is updated.
    /// @param newTreasury The newly-set 0x proxy address (parameter kept as
    ///        `newTreasury` for ABI stability — do not rename post-launch).
    event ZeroExProxySet(address indexed newTreasury);

    /// @notice Emitted when the 0x allowance-target is updated.
    /// @param newAllowanceTargetSet The newly-set 0x allowance-target address.
    event AllowanceTargetSet(address indexed newAllowanceTargetSet);

    /// @notice Emitted when the Phase 1 KYC pass-through flag is toggled.
    /// @param enforced True => KYC checks enforce tiered thresholds; false =>
    ///        pass-through (the Phase 1 launch default per README §16).
    event KYCEnforcementSet(bool enforced);

    /// @notice Emitted when an individual asset is paused. Creation paths
    ///         touching this asset will revert `AssetPaused`; exit paths
    ///         (repay / liquidate / claim / withdraw) remain callable.
    /// @param asset The asset (ERC-20 / ERC-721 / ERC-1155) that was paused.
    event AssetPauseEnabled(address indexed asset);

    /// @notice Emitted when a previously paused asset is unpaused. Creation
    ///         paths touching this asset become callable again.
    /// @param asset The asset that was unpaused.
    event AssetPauseDisabled(address indexed asset);

    // InvalidAddress inherited from IVaipakamErrors

    /// @notice Sets the treasury address that receives protocol fees.
    /// @dev ADMIN_ROLE-only. Reverts with InvalidAddress on zero. Emits
    ///      TreasurySet. Does not sweep existing balances; only routes
    ///      future credits.
    /// @param newTreasury The new treasury address (must be non-zero).
    function setTreasury(address newTreasury) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (newTreasury == address(0)) revert InvalidAddress();

        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.treasury = newTreasury;

        emit TreasurySet(newTreasury);
    }

    /// @notice Sets the 0x ExchangeProxy address used by RiskFacet /
    ///         DefaultedFacet for liquidation swaps.
    /// @dev ADMIN_ROLE-only. Reverts with InvalidAddress on zero. Emits
    ///      ZeroExProxySet. Must be paired with {setallowanceTarget} — the
    ///      allowance-target may differ from the proxy address on some chains.
    /// @param newProxy The new 0x ExchangeProxy address (must be non-zero).
    function setZeroExProxy(address newProxy) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (newProxy == address(0)) revert InvalidAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.zeroExProxy = newProxy;
        emit ZeroExProxySet(newProxy);
    }

    /// @notice Sets the 0x allowance-target address (the address that actually
    ///         pulls tokens during a swap — may differ from the ExchangeProxy).
    /// @dev ADMIN_ROLE-only. Reverts with InvalidAddress on zero. Emits
    ///      AllowanceTargetSet. Name kept lower-case for ABI stability.
    /// @param newAllowanceTargetSet The new 0x allowance-target address
    ///        (must be non-zero).
    function setallowanceTarget(address newAllowanceTargetSet) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (newAllowanceTargetSet == address(0)) revert InvalidAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.allowanceTarget = newAllowanceTargetSet;
        emit AllowanceTargetSet(newAllowanceTargetSet);
    }

    /// @notice Returns the current protocol treasury address.
    /// @return treasury The configured treasury address (zero if unset).
    function getTreasury() external view returns (address treasury) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return s.treasury;
    }

    // ─── Phase 1 KYC Pass-Through ──────────────────────────────────────────
    //
    // README §16 requires that all KYC-related protocol checks pass through
    // under an explicit Phase 1 flag or equivalent configuration path. The
    // flag defaults to false (pass-through) so unconfigured deployments are
    // spec-compliant; governance may flip it to true in a later phase to
    // activate the retained tiered-KYC framework without a diamond cut.

    /// @notice Enables or disables tiered KYC enforcement for
    ///         ProfileFacet.meetsKYCRequirement and isKYCVerified.
    /// @dev ADMIN_ROLE-only. Emits {KYCEnforcementSet}. When false (the
    ///      Phase 1 default), both KYC view functions return true so no
    ///      user flow is blocked. The underlying tier / threshold storage
    ///      and {ProfileFacet.updateKYCTier} remain operational regardless.
    /// @param enforced True to activate tiered enforcement, false to keep
    ///        (or return to) Phase 1 pass-through.
    function setKYCEnforcement(bool enforced) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.kycEnforcementEnabled = enforced;
        emit KYCEnforcementSet(enforced);
    }

    /// @notice Returns whether KYC enforcement is currently active.
    /// @return enforced False under Phase 1 pass-through (default), true when
    ///         governance has activated tiered enforcement.
    function isKYCEnforcementEnabled() external view returns (bool enforced) {
        return LibVaipakam.storageSlot().kycEnforcementEnabled;
    }

    // ─── Pause Controls ─────────────────────────────────────────────────────

    /// @notice Pauses the protocol. Every facet entry point guarded by
    ///         `whenNotPaused` will revert LibPausable.EnforcedPause until
    ///         {unpause} is called.
    /// @dev PAUSER_ROLE-only. Emits LibPausable.Paused. Admin / role-mgmt /
    ///      diamond-cut / oracle-admin / escrow-upgrade paths intentionally
    ///      remain callable while paused — see PauseGatingTest for the full
    ///      gated surface.
    function pause() external onlyRole(LibAccessControl.PAUSER_ROLE) {
        LibPausable.pause();
    }

    /// @notice Lifts the pause, re-enabling all `whenNotPaused` entry points.
    /// @dev PAUSER_ROLE-only. Emits LibPausable.Unpaused.
    function unpause() external onlyRole(LibAccessControl.PAUSER_ROLE) {
        LibPausable.unpause();
    }

    /// @notice Returns whether the protocol is currently paused.
    /// @return True iff a {pause} call is currently in effect.
    function paused() external view returns (bool) {
        return LibPausable.paused();
    }

    // ─── Per-Asset Pause (governance-controlled reserve pause) ─────────────
    //
    // Pausing an asset blocks every CREATION path that would add new
    // exposure through it (createOffer, acceptOffer, addCollateral,
    // refinanceLoan, offsetWithNewOffer), while leaving every EXIT path
    // (repay, triggerLiquidation, triggerDefault, claim, withdraw,
    // stake) fully callable. Use this when an asset must be quietly
    // wound down without freezing users who already hold positions in
    // it. Enforcement is centralised in {LibFacet.requireAssetNotPaused}.

    /// @notice Pauses a single asset. Idempotent (re-pausing is a no-op
    ///         emit).
    /// @dev ADMIN_ROLE *or* PAUSER_ROLE. Post-launch ADMIN_ROLE sits behind
    ///      a timelock, so PAUSER_ROLE (a fast-key multisig) is the
    ///      practical incident-response surface. Reverts with
    ///      InvalidAddress on zero. Does NOT affect existing offers/loans
    ///      that already reference the asset — exit paths remain callable.
    ///      Emits AssetPauseEnabled.
    /// @param asset The asset to pause.
    function pauseAsset(address asset) external onlyAdminOrPauser {
        if (asset == address(0)) revert InvalidAddress();
        LibVaipakam.storageSlot().assetPaused[asset] = true;
        emit AssetPauseEnabled(asset);
    }

    /// @notice Unpauses a previously paused asset. Idempotent.
    /// @dev ADMIN_ROLE *or* PAUSER_ROLE — mirrors {pauseAsset} so the same
    ///      responder key can both engage and lift a reserve pause without
    ///      waiting on the timelocked admin. Reverts with InvalidAddress
    ///      on zero. Emits AssetPauseDisabled.
    /// @param asset The asset to unpause.
    function unpauseAsset(address asset) external onlyAdminOrPauser {
        if (asset == address(0)) revert InvalidAddress();
        LibVaipakam.storageSlot().assetPaused[asset] = false;
        emit AssetPauseDisabled(asset);
    }

    /// @notice Returns whether an asset is currently paused for creation.
    /// @param asset The asset to query.
    /// @return True iff {pauseAsset} has been called and not since
    ///         reversed by {unpauseAsset}.
    function isAssetPaused(address asset) external view returns (bool) {
        return LibVaipakam.storageSlot().assetPaused[asset];
    }
}
