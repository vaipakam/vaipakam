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

    /// @notice Emitted when a swap adapter is appended to the liquidation
    ///         failover chain. Phase 7a.
    /// @param index   Slot the adapter occupies after the append (its
    ///                priority — lower runs first).
    /// @param adapter The {ISwapAdapter} contract address.
    event SwapAdapterAdded(uint256 indexed index, address indexed adapter);

    /// @notice Emitted when a swap adapter is removed from the failover
    ///         chain. Remaining adapters shift down to close the gap.
    /// @param index   Slot the adapter occupied before removal.
    /// @param adapter The removed {ISwapAdapter} address.
    event SwapAdapterRemoved(uint256 indexed index, address indexed adapter);

    /// @notice Emitted when the swap adapter chain is reordered. The
    ///         full new ordering is emitted so off-chain monitors can
    ///         pick it up atomically. Phase 7a.
    /// @param adapters The adapter array after reordering, index 0 first.
    event SwapAdaptersReordered(address[] adapters);

    // InvalidAddress inherited from IVaipakamErrors

    /// @notice Thrown when attempting to add an adapter that's already
    ///         registered — we keep the list de-duplicated so reorder
    ///         operations are unambiguous.
    error SwapAdapterAlreadyRegistered();

    /// @notice Thrown when a removal or reorder references an adapter
    ///         that isn't currently registered.
    error SwapAdapterNotRegistered();

    /// @notice Thrown when a reorder receives a permutation that doesn't
    ///         match the currently-registered set (different length or
    ///         different members).
    error SwapAdapterReorderMismatch();

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

    // ─── Phase 7a: swap adapter failover chain ──────────────────────────
    //
    // The liquidation path (RiskFacet / DefaultedFacet / ClaimFacet
    // retry) drives a priority-ordered failover across registered
    // {ISwapAdapter} contracts via {LibSwap.swapWithFailover}. Index 0
    // runs first; each subsequent slot is tried only if the previous
    // one reverted. An empty chain blocks liquidation entirely so
    // every live deployment must populate this array before enabling
    // loan settlement. Adapter addresses are deployment-specific
    // (different DEX addresses per chain) — governance registers the
    // chain-correct set at configuration time.

    /// @notice Append a swap adapter to the end of the failover chain.
    /// @dev ADMIN_ROLE-only. Rejects the zero address and duplicates.
    ///      Emits {SwapAdapterAdded}. Does NOT sanity-check the
    ///      adapter's contract interface — admin is trusted to register
    ///      only {ISwapAdapter} implementations.
    /// @param adapter The adapter contract to register.
    function addSwapAdapter(address adapter) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (adapter == address(0)) revert InvalidAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 n = s.swapAdapters.length;
        for (uint256 i = 0; i < n; ++i) {
            if (s.swapAdapters[i] == adapter) revert SwapAdapterAlreadyRegistered();
        }
        s.swapAdapters.push(adapter);
        emit SwapAdapterAdded(n, adapter);
    }

    /// @notice Remove a swap adapter from the failover chain.
    /// @dev ADMIN_ROLE-only. Preserves the relative order of the
    ///      remaining adapters (shift-down). Emits
    ///      {SwapAdapterRemoved}. Reverts if the adapter is not
    ///      currently registered.
    /// @param adapter The adapter contract to de-register.
    function removeSwapAdapter(address adapter) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 n = s.swapAdapters.length;
        for (uint256 i = 0; i < n; ++i) {
            if (s.swapAdapters[i] == adapter) {
                for (uint256 j = i; j < n - 1; ++j) {
                    s.swapAdapters[j] = s.swapAdapters[j + 1];
                }
                s.swapAdapters.pop();
                emit SwapAdapterRemoved(i, adapter);
                return;
            }
        }
        revert SwapAdapterNotRegistered();
    }

    /// @notice Replace the adapter order with an explicit permutation.
    /// @dev ADMIN_ROLE-only. `newOrder` must contain exactly the same
    ///      set of addresses currently registered (same length, same
    ///      members, no duplicates) — any mismatch reverts
    ///      {SwapAdapterReorderMismatch}. Emits {SwapAdaptersReordered}
    ///      with the new ordering on success.
    /// @param newOrder Permutation of the current adapter set; element 0
    ///        becomes the new priority-0 adapter.
    function reorderSwapAdapters(address[] calldata newOrder)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint256 n = s.swapAdapters.length;
        if (newOrder.length != n) revert SwapAdapterReorderMismatch();

        // Membership check: every entry in `newOrder` must already be
        // registered, and no duplicates allowed.
        for (uint256 i = 0; i < n; ++i) {
            address candidate = newOrder[i];
            if (candidate == address(0)) revert InvalidAddress();
            // Reject duplicates within the supplied permutation.
            for (uint256 j = 0; j < i; ++j) {
                if (newOrder[j] == candidate) revert SwapAdapterReorderMismatch();
            }
            // Must be currently registered.
            bool found = false;
            for (uint256 k = 0; k < n; ++k) {
                if (s.swapAdapters[k] == candidate) {
                    found = true;
                    break;
                }
            }
            if (!found) revert SwapAdapterReorderMismatch();
        }

        for (uint256 i = 0; i < n; ++i) {
            s.swapAdapters[i] = newOrder[i];
        }
        emit SwapAdaptersReordered(newOrder);
    }

    /// @notice Read the current priority-ordered swap adapter chain.
    /// @return adapters Registered adapters, index 0 first (highest priority).
    function getSwapAdapters() external view returns (address[] memory adapters) {
        return LibVaipakam.storageSlot().swapAdapters;
    }

    // ─── Phase 7b: multi-venue liquidity check (3-V3-clone OR-logic) ──
    //
    // UniswapV3, PancakeSwap V3, and SushiSwap V3 are all Uniswap V3
    // forks at the contract layer — same `getPool(token0, token1, fee)`
    // factory lookup, same `slot0()` / `liquidity()` pool views. The
    // OracleFacet liquidity probe runs the SAME depth-probe helper
    // against each registered factory and OR-combines: an asset is
    // classified Liquid iff at least one factory exposes a pool with
    // sufficient depth. Zero per-asset governance config — pool
    // discovery is on-chain via the factory.
    //
    // Setting a factory address to zero disables that leg; the OR-
    // combine collapses to whichever other factories are configured.
    // BNB Chain and Polygon zkEVM (no UniV3 deployment) rely on
    // PancakeV3 + SushiV3 instead.

    /// @notice Emitted when the PancakeSwap V3 factory address is updated.
    event PancakeswapV3FactorySet(address indexed previous, address indexed current);
    /// @notice Emitted when the SushiSwap V3 factory address is updated.
    event SushiswapV3FactorySet(address indexed previous, address indexed current);

    /// @notice Set the chain's PancakeSwap V3 factory address.
    /// @dev ADMIN_ROLE-only. Pass `address(0)` to disable PancakeV3's
    ///      leg of the liquidity OR-logic.
    function setPancakeswapV3Factory(address newFactory) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address prev = s.pancakeswapV3Factory;
        s.pancakeswapV3Factory = newFactory;
        emit PancakeswapV3FactorySet(prev, newFactory);
    }

    /// @notice Read the PancakeSwap V3 factory address. Zero disables
    ///         PancakeV3's leg of the liquidity OR-logic.
    function getPancakeswapV3Factory() external view returns (address) {
        return LibVaipakam.storageSlot().pancakeswapV3Factory;
    }

    /// @notice Set the chain's SushiSwap V3 factory address.
    /// @dev ADMIN_ROLE-only. Pass `address(0)` to disable SushiV3's
    ///      leg of the liquidity OR-logic.
    function setSushiswapV3Factory(address newFactory) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address prev = s.sushiswapV3Factory;
        s.sushiswapV3Factory = newFactory;
        emit SushiswapV3FactorySet(prev, newFactory);
    }

    /// @notice Read the SushiSwap V3 factory address. Zero disables
    ///         SushiV3's leg of the liquidity OR-logic.
    function getSushiswapV3Factory() external view returns (address) {
        return LibVaipakam.storageSlot().sushiswapV3Factory;
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
    /// @return True iff a {pause} call is currently in effect, OR an
    ///         auto-pause window is still active.
    function paused() external view returns (bool) {
        return LibPausable.paused();
    }

    /// @notice Auto-pause primitive used by the off-chain anomaly
    ///         watcher (Phase 1 follow-up). Freezes the protocol for
    ///         `LibVaipakam.cfgAutoPauseDurationSeconds()` while
    ///         humans investigate. Time-bounded; auto-clears at
    ///         `block.timestamp + duration` without a manual
    ///         unpause tx. Admin can still short-circuit via
    ///         {unpause}.
    /// @dev WATCHER_ROLE-only — write-only-pause; admin's PAUSER_ROLE
    ///      retains the unpause lever, so the worst case for a
    ///      compromised watcher is a max-window freeze (capped at
    ///      `MAX_AUTO_PAUSE_SECONDS = 7200`, 2 hours), not
    ///      indefinite lockup.
    ///
    ///      No-op when the protocol is already paused (manual or
    ///      active auto-pause). This prevents a compromised watcher
    ///      from chaining repeated calls into an indefinite freeze:
    ///      the most it can do is set the window once, after which
    ///      the window auto-clears and any extension would be a
    ///      separate event the human team can correlate with the
    ///      attack.
    /// @param reason Free-form string for indexers + alerting; surfaces
    ///               in the `LibPausable.AutoPaused` event so on-call
    ///               can see what triggered.
    function autoPause(string calldata reason)
        external
        onlyRole(LibAccessControl.WATCHER_ROLE)
    {
        LibPausable.autoPause(
            LibVaipakam.cfgAutoPauseDurationSeconds(),
            reason
        );
    }

    /// @notice Block-timestamp at which an active auto-pause window
    ///         expires. Zero when no auto-pause is currently active.
    ///         Frontends use this to render a countdown.
    function pausedUntil() external view returns (uint256) {
        return LibPausable.pausedUntil();
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
