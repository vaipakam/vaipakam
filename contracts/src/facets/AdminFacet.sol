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
 *      ADMIN_ROLE for configuration, PAUSER_ROLE for pause,
 *      UNPAUSER_ROLE for unpause (asymmetric-asymmetric split — see
 *      LibAccessControl.UNPAUSER_ROLE rationale).
 */
contract AdminFacet is DiamondAccessControl, IVaipakamErrors {
    /// @dev Accepts either ADMIN_ROLE or PAUSER_ROLE. Used for per-asset
    ///      PAUSE so incident response stays actionable once ADMIN_ROLE
    ///      is handed to a time-locked governance executor — PAUSER_ROLE
    ///      can remain a fast-key multisig. Mirror modifier
    ///      {onlyAdminOrUnpauser} gates the inverse (asset unpause).
    /// @dev Extracted modifier body — the modifier stays a thin wrapper
    ///      so each call site inlines one function call instead of the
    ///      full role check, deduping bytecode.
    function _checkAdminOrPauser() private view {
        if (
            !LibAccessControl.hasRole(LibAccessControl.ADMIN_ROLE, msg.sender) &&
            !LibAccessControl.hasRole(LibAccessControl.PAUSER_ROLE, msg.sender)
        ) {
            revert LibAccessControl.AccessControlUnauthorizedAccount(
                msg.sender,
                LibAccessControl.PAUSER_ROLE
            );
        }
    }

    modifier onlyAdminOrPauser() {
        _checkAdminOrPauser();
        _;
    }

    /// @dev Accepts either ADMIN_ROLE or UNPAUSER_ROLE. Mirrors
    ///      {onlyAdminOrPauser} for the asymmetric inverse — admin's
    ///      time-locked surface is the natural unpause-with-delay
    ///      lever, and UNPAUSER_ROLE is the explicit deliberate-reset
    ///      key. Splitting unpause off PAUSER_ROLE means a compromised
    ///      Pauser cannot un-do its own mistaken pause without going
    ///      through the slower UNPAUSER (Timelock) surface, giving
    ///      on-call operators a review window to confirm the incident
    ///      is genuinely resolved.
    /// @dev Extracted modifier body — same wrapper pattern as
    ///      {_checkAdminOrPauser} above.
    function _checkAdminOrUnpauser() private view {
        if (
            !LibAccessControl.hasRole(LibAccessControl.ADMIN_ROLE, msg.sender) &&
            !LibAccessControl.hasRole(LibAccessControl.UNPAUSER_ROLE, msg.sender)
        ) {
            revert LibAccessControl.AccessControlUnauthorizedAccount(
                msg.sender,
                LibAccessControl.UNPAUSER_ROLE
            );
        }
    }

    modifier onlyAdminOrUnpauser() {
        _checkAdminOrUnpauser();
        _;
    }

    /// @notice Emitted when the protocol treasury address is updated.
    /// @param newTreasury The newly-set treasury address.
    /// @custom:event-category informational/config
    event TreasurySet(address indexed newTreasury);

    /// @notice Emitted when the 0x proxy used for liquidation swaps is updated.
    /// @param newTreasury The newly-set 0x proxy address (parameter kept as
    ///        `newTreasury` for ABI stability — do not rename post-launch).
    /// @custom:event-category informational/config
    event ZeroExProxySet(address indexed newTreasury);

    /// @notice Emitted when the 0x allowance-target is updated.
    /// @param newAllowanceTargetSet The newly-set 0x allowance-target address.
    /// @custom:event-category informational/config
    event AllowanceTargetSet(address indexed newAllowanceTargetSet);

    /// @notice Emitted when the Phase 1 KYC pass-through flag is toggled.
    /// @param enforced True => KYC checks enforce tiered thresholds; false =>
    ///        pass-through (the Phase 1 launch default per README §16).
    /// @custom:event-category informational/config
    event KYCEnforcementSet(bool enforced);

    /// @notice T-092 (#508) — auto-lifecycle admin kill switches.
    /// @custom:event-category informational/config
    event AutoLendEnabledSet(bool enabled);
    /// @custom:event-category informational/config
    event AutoRefinanceEnabledSet(bool enabled);
    /// @custom:event-category informational/config
    event AutoExtendEnabledSet(bool enabled);

    /// @notice Emitted when an individual asset is paused. Creation paths
    ///         touching this asset will revert `AssetPaused`; exit paths
    ///         (repay / liquidate / claim / withdraw) remain callable.
    /// @param asset The asset (ERC-20 / ERC-721 / ERC-1155) that was paused.
    /// @custom:event-category informational/admin
    event AssetPauseEnabled(address indexed asset);

    /// @notice Emitted when a previously paused asset is unpaused. Creation
    ///         paths touching this asset become callable again.
    /// @param asset The asset that was unpaused.
    /// @custom:event-category informational/admin
    event AssetPauseDisabled(address indexed asset);

    /// @notice Emitted when a swap adapter is appended to the liquidation
    ///         failover chain. Phase 7a.
    /// @param index   Slot the adapter occupies after the append (its
    ///                priority — lower runs first).
    /// @param adapter The {ISwapAdapter} contract address.
    /// @custom:event-category informational/config
    event SwapAdapterAdded(uint256 indexed index, address indexed adapter);

    /// @notice Emitted when a swap adapter is removed from the failover
    ///         chain. Remaining adapters shift down to close the gap.
    /// @param index   Slot the adapter occupied before removal.
    /// @param adapter The removed {ISwapAdapter} address.
    /// @custom:event-category informational/config
    event SwapAdapterRemoved(uint256 indexed index, address indexed adapter);

    /// @notice #633 — emitted when a swap venue is paused/unpaused by address.
    event SwapAdapterDisabledSet(address indexed adapter, bool disabled);

    /// @notice Emitted when the swap adapter chain is reordered. The
    ///         full new ordering is emitted so off-chain monitors can
    ///         pick it up atomically. Phase 7a.
    /// @param adapters The adapter array after reordering, index 0 first.
    /// @custom:event-category informational/config
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

    /// @notice #633 — pause/unpause a single swap venue without de-registering it.
    /// @dev ADMIN_ROLE-only (Timelock post-handover). Keyed by adapter ADDRESS,
    ///      so it survives `swapAdapters` reordering/removal (unlike an index).
    ///      A disabled adapter is SKIPPED by {LibSwap}'s failover + split routing,
    ///      so a compromised or illiquid venue can be paused while liquidations
    ///      keep routing through the remaining venues. Default `false` = active.
    ///      Emits {SwapAdapterDisabledSet}.
    /// @param adapter  The registered adapter to toggle.
    /// @param disabled True to pause, false to re-activate.
    function setSwapAdapterDisabled(address adapter, bool disabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (adapter == address(0)) revert InvalidAddress();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // Reject typo/stale addresses: routing only consults swapAdapterDisabled
        // for adapters present in `swapAdapters`, so pausing an unregistered
        // address would be a silent no-op that leaves the intended venue usable.
        uint256 n = s.swapAdapters.length;
        bool found;
        for (uint256 i = 0; i < n; ++i) {
            if (s.swapAdapters[i] == adapter) {
                found = true;
                break;
            }
        }
        if (!found) revert SwapAdapterNotRegistered();
        s.swapAdapterDisabled[adapter] = disabled;
        emit SwapAdapterDisabledSet(adapter, disabled);
    }

    /// @notice #633 — whether a swap venue is currently paused (skipped by routing).
    function isSwapAdapterDisabled(address adapter) external view returns (bool) {
        return LibVaipakam.storageSlot().swapAdapterDisabled[adapter];
    }

    // ─── #633 feature kill-switches (pause semantics; default false = active) ───
    // Housed on AdminFacet (not ConfigFacet, which is at the EIP-170 edge);
    // cohesive with the swap-venue pause above. ADMIN_ROLE now, Timelock after
    // handover. Default active ⇒ fresh deploy preserves current behaviour.

    /// @notice Emitted when the #398 aggregator-adapter feature is paused/unpaused.
    event AggregatorAdaptersPausedSet(bool paused);
    /// @notice Emitted when the global delegated-keeper pause is toggled.
    event KeepersPausedSet(bool paused);
    /// @notice Emitted when peer-protocol LTV reads are paused/unpaused.
    event PeerLtvReadsPausedSet(bool paused);

    /// @notice Pause/unpause the #398 ERC-4626 aggregator-adapter feature
    ///         (new-adapter onboarding + adapter-intent fills).
    function setAggregatorAdaptersPaused(bool value)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.aggregatorAdaptersPaused = value;
        emit AggregatorAdaptersPausedSet(value);
    }

    /// @notice Globally pause/unpause DELEGATED keeper actions (NFT owners can
    ///         still act directly; permissionless liquidation is unaffected).
    function setKeepersPaused(bool value)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.keepersPaused = value;
        emit KeepersPausedSet(value);
    }

    /// @notice #633 — the global delegated-keeper pause flag. External so the
    ///         aggregator adapters (which gate their keeper forwarders on it) and
    ///         the frontend can read it.
    function keepersPaused() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.keepersPaused;
    }

    /// @notice Pause/unpause optional peer-protocol (Aave/Compound) LTV reads;
    ///         when paused the depth-tiered LTV falls back to governance defaults.
    function setPeerLtvReadsPaused(bool value)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.protocolCfg.peerLtvReadsPaused = value;
        // #633 (Codex r3 P1) — invalidate the peer-LTV cache on every toggle.
        // Otherwise UNPAUSING would immediately re-trust any still-fresh cached
        // entry — including the compromised reading the pause was meant to
        // neutralize — before `refreshTierLtvCache()` (which can't run while
        // paused) is re-run. Zeroing `lastRefreshedAt` forces
        // `effectiveTierMaxInitLtvBps` to use the governance cap until a fresh
        // post-unpause refresh succeeds.
        for (uint8 t = 1; t <= LibVaipakam.MAX_LIQUIDITY_TIER; ++t) {
            s.tierLtvCache[t].lastRefreshedAt = 0;
        }
        emit PeerLtvReadsPausedSet(value);
    }

    /// @notice Emitted on every change to the #395 graduated partial-
    ///         liquidation sizing parameters.
    /// @custom:event-category informational/config
    event PartialLiquidationSizingSet(
        uint16 targetHfCeilingBps,
        uint16 deepUnderwaterHfBps,
        uint256 dustFloorNumeraire
    );

    /// @notice A #395 sizing parameter was outside its governance range.
    error InvalidPartialLiqSizing();

    /// @notice Set the #395 graduated partial-liquidation sizing knobs in one
    ///         atomic write (Approach A). Hosted here (not `ConfigFacet`)
    ///         because `ConfigFacet` is at the EIP-170 ceiling — same reason
    ///         the #633 kill-switch setters live here.
    /// @dev    ADMIN_ROLE-only. Each parameter accepts `0` to mean "reset to
    ///         the library default"; any non-zero value is range-checked so
    ///         the reads in `RiskFacet._assertPartialSizing` are trusted
    ///         unconditionally:
    ///           - `targetHfCeilingBps`  ∈ [MIN, MAX]_PARTIAL_LIQ_TARGET_HF_CEILING_BPS
    ///             (HF 1.05–1.50) — the routine over-liquidation ceiling.
    ///           - `deepUnderwaterHfBps` ∈ [MIN, MAX]_PARTIAL_LIQ_DEEP_UNDERWATER_HF_BPS
    ///             (HF 0.80–0.99) — must stay below the HF=1.0 restore floor.
    ///           - `dustFloorNumeraire`  ≤ MAX_LIQUIDATION_DUST_FLOOR_NUMERAIRE
    ///             ($100k) — caps a misconfig that would turn every routine
    ///             partial into a full close.
    /// @param  targetHfCeilingBps   Routine over-liquidation HF ceiling (BPS of HF_SCALE), or 0.
    /// @param  deepUnderwaterHfBps  Deep-underwater escalation HF (BPS of HF_SCALE), or 0.
    /// @param  dustFloorNumeraire   Dust floor in the whole-numeraire scale
    ///         `_computeNumeraireValues` returns (whole-USD with 8-decimal
    ///         feeds; $1k == 1_000), or 0 to reset to the default.
    function setPartialLiquidationSizing(
        uint16 targetHfCeilingBps,
        uint16 deepUnderwaterHfBps,
        uint256 dustFloorNumeraire
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        if (
            targetHfCeilingBps != 0 &&
            (targetHfCeilingBps < LibVaipakam.MIN_PARTIAL_LIQ_TARGET_HF_CEILING_BPS ||
                targetHfCeilingBps > LibVaipakam.MAX_PARTIAL_LIQ_TARGET_HF_CEILING_BPS)
        ) revert InvalidPartialLiqSizing();
        if (
            deepUnderwaterHfBps != 0 &&
            (deepUnderwaterHfBps < LibVaipakam.MIN_PARTIAL_LIQ_DEEP_UNDERWATER_HF_BPS ||
                deepUnderwaterHfBps > LibVaipakam.MAX_PARTIAL_LIQ_DEEP_UNDERWATER_HF_BPS)
        ) revert InvalidPartialLiqSizing();
        if (dustFloorNumeraire > LibVaipakam.MAX_LIQUIDATION_DUST_FLOOR_NUMERAIRE) {
            revert InvalidPartialLiqSizing();
        }
        // #395 sizing knobs live at the `Storage` tail (layout-safe), NOT in
        // `ProtocolConfig` — see the LibVaipakam declarations.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.partialLiqTargetHfCeilingBps = targetHfCeilingBps;
        s.partialLiqDeepUnderwaterHfBps = deepUnderwaterHfBps;
        s.liquidationDustFloorNumeraire = dustFloorNumeraire;
        emit PartialLiquidationSizingSet(
            targetHfCeilingBps,
            deepUnderwaterHfBps,
            dustFloorNumeraire
        );
    }

    /// @notice The #395 partial-liquidation sizing knobs currently in EFFECT
    ///         (governance value, or the library default where unset). Codex
    ///         r1 P2 — keeper bots read this to size a partial that will pass
    ///         `RiskFacet.triggerPartialLiquidation` after a governance change,
    ///         rather than guessing defaults or decoding raw storage.
    /// @return targetHfCeilingBps   Effective routine over-liquidation HF ceiling (BPS of HF_SCALE).
    /// @return deepUnderwaterHfBps  Effective deep-underwater escalation HF (BPS of HF_SCALE).
    /// @return dustFloorNumeraire   Effective dust floor (whole-numeraire; $1k == 1_000).
    function getPartialLiquidationSizing()
        external
        view
        returns (
            uint256 targetHfCeilingBps,
            uint256 deepUnderwaterHfBps,
            uint256 dustFloorNumeraire
        )
    {
        targetHfCeilingBps = LibVaipakam.cfgPartialLiqTargetHfCeilingBps();
        deepUnderwaterHfBps = LibVaipakam.cfgPartialLiqDeepUnderwaterHfBps();
        dustFloorNumeraire = LibVaipakam.cfgLiquidationDustFloorNumeraire();
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
    /// @custom:event-category informational/config
    event PancakeswapV3FactorySet(address indexed previous, address indexed current);
    /// @notice Emitted when the SushiSwap V3 factory address is updated.
    /// @custom:event-category informational/config
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

    // ─── Depth-tiered LTV — Uni-V2-fork family (Piece B follow-up b) ───────
    // Per-chain Uni-V2-clone factory addresses consulted by
    // `OracleFacet.getLiquidityTier`'s route search alongside the V3
    // trio. V2 pools have real reserves (no virtual-reserve
    // approximation) — exact CPMM math — and each clone's canonical
    // single fee tier differs (UniV2 / SushiV2 = 30bps; PancakeV2 =
    // 25bps), fed into the same `LibSlippage.priceImpactBps`. A zero
    // factory skips that leg.

    /// @custom:event-category informational/config
    event UniswapV2FactorySet(address indexed previous, address indexed current);
    /// @custom:event-category informational/config
    event SushiswapV2FactorySet(address indexed previous, address indexed current);
    /// @custom:event-category informational/config
    event PancakeswapV2FactorySet(address indexed previous, address indexed current);

    /// @notice Set the chain's Uniswap V2 factory address. ADMIN_ROLE-only.
    ///         Pass `address(0)` to disable UniV2's leg of the route search.
    function setUniswapV2Factory(address newFactory) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address prev = s.uniswapV2Factory;
        s.uniswapV2Factory = newFactory;
        emit UniswapV2FactorySet(prev, newFactory);
    }

    /// @notice Read the Uniswap V2 factory address. Zero disables its leg.
    function getUniswapV2Factory() external view returns (address) {
        return LibVaipakam.storageSlot().uniswapV2Factory;
    }

    /// @notice Set the chain's SushiSwap V2 factory address. ADMIN_ROLE-only.
    function setSushiswapV2Factory(address newFactory) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address prev = s.sushiswapV2Factory;
        s.sushiswapV2Factory = newFactory;
        emit SushiswapV2FactorySet(prev, newFactory);
    }

    /// @notice Read the SushiSwap V2 factory address. Zero disables its leg.
    function getSushiswapV2Factory() external view returns (address) {
        return LibVaipakam.storageSlot().sushiswapV2Factory;
    }

    /// @notice Set the chain's PancakeSwap V2 factory address. ADMIN_ROLE-only.
    function setPancakeswapV2Factory(address newFactory) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address prev = s.pancakeswapV2Factory;
        s.pancakeswapV2Factory = newFactory;
        emit PancakeswapV2FactorySet(prev, newFactory);
    }

    /// @notice Read the PancakeSwap V2 factory address. Zero disables its leg.
    function getPancakeswapV2Factory() external view returns (address) {
        return LibVaipakam.storageSlot().pancakeswapV2Factory;
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
    // forge-lint: disable-next-line(mixed-case-function)
    function setKYCEnforcement(bool enforced) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.kycEnforcementEnabled = enforced;
        emit KYCEnforcementSet(enforced);
    }

    /// ─── T-092 (#508) — auto-lifecycle admin kill switches ──────────
    /// All three default `false` on a fresh deploy. Setters live on
    /// AdminFacet (not ConfigFacet) because ConfigFacet's runtime
    /// bytecode is already near the EIP-170 24,576-byte ceiling.

    /// @notice Toggle whether users may opt INTO auto-lend
    ///         (`AutoLifecycleFacet.setAutoLendConsent(true)`).
    ///         When `false`, attempting to enable consent reverts;
    ///         already-consented users stay consented but the dapp
    ///         gates the auto-post behaviour on this flag too.
    function setAutoLendEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.cfgAutoLendEnabled = enabled;
        emit AutoLendEnabledSet(enabled);
    }

    /// @notice Toggle whether the keeper-driven path of
    ///         `RefinanceFacet.refinanceLoan` is open. When `false`,
    ///         keeper invocations revert; borrower-NFT-owner direct
    ///         calls still succeed (the borrower acts in their own
    ///         interest, no kill-switch protection needed).
    function setAutoRefinanceEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.cfgAutoRefinanceEnabled = enabled;
        emit AutoRefinanceEnabledSet(enabled);
    }

    /// @notice Toggle the whole `AutoLifecycleFacet.extendLoanInPlace`
    ///         entry point. When `false`, both keeper-driven AND
    ///         borrower-direct extension calls revert — the executor
    ///         IS the only entry point, so the kill switch covers
    ///         both invocation modes.
    function setAutoExtendEnabled(bool enabled)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().protocolCfg.cfgAutoExtendEnabled = enabled;
        emit AutoExtendEnabledSet(enabled);
    }

    /// @notice Codex round-1 P2 — getter trio so the dapp + keeper
    ///         bots can decide whether to surface / submit the
    ///         relevant auto-lifecycle action. Matches the
    ///         `getPartialFillEnabled` precedent (write-only flags
    ///         would force consumers to simulate failed sends to
    ///         discover state).
    function getAutoLendEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.cfgAutoLendEnabled;
    }

    function getAutoRefinanceEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.cfgAutoRefinanceEnabled;
    }

    function getAutoExtendEnabled() external view returns (bool) {
        return LibVaipakam.storageSlot().protocolCfg.cfgAutoExtendEnabled;
    }

    /// @notice Returns whether KYC enforcement is currently active.
    /// @return enforced False under Phase 1 pass-through (default), true when
    ///         governance has activated tiered enforcement.
    // forge-lint: disable-next-line(mixed-case-function)
    function isKYCEnforcementEnabled() external view returns (bool enforced) {
        return LibVaipakam.storageSlot().kycEnforcementEnabled;
    }

    // ─── Pause Controls ─────────────────────────────────────────────────────

    /// @notice Pauses the protocol. Every facet entry point guarded by
    ///         `whenNotPaused` will revert LibPausable.EnforcedPause until
    ///         {unpause} is called.
    /// @dev PAUSER_ROLE-only. Emits LibPausable.Paused. Admin / role-mgmt /
    ///      diamond-cut / oracle-admin / vault-upgrade paths intentionally
    ///      remain callable while paused — see PauseGatingTest for the full
    ///      gated surface.
    function pause() external onlyRole(LibAccessControl.PAUSER_ROLE) {
        LibPausable.pause();
    }

    /// @notice Lifts the pause, re-enabling all `whenNotPaused` entry points.
    /// @dev UNPAUSER_ROLE-only — split off PAUSER_ROLE to enforce the
    ///      asymmetric pause pattern. PAUSER_ROLE is the
    ///      fast incident lever; UNPAUSER_ROLE is the deliberate reset
    ///      gate, held by the Timelock at handover so a real-incident
    ///      unpause waits its `minDelay` review window. Emits
    ///      LibPausable.Unpaused.
    function unpause() external onlyRole(LibAccessControl.UNPAUSER_ROLE) {
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
    /// @dev WATCHER_ROLE-only — write-only-pause; UNPAUSER_ROLE
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
    /// @dev ADMIN_ROLE *or* UNPAUSER_ROLE — the asymmetric inverse of
    ///      {pauseAsset}. PAUSER_ROLE is intentionally NOT accepted
    ///      here so a compromised fast-key multisig cannot un-do its
    ///      own mistaken pause without going through ADMIN_ROLE
    ///      (time-locked) or UNPAUSER_ROLE (also Timelock at
    ///      handover). Reverts with InvalidAddress on zero. Emits
    ///      AssetPauseDisabled.
    /// @param asset The asset to unpause.
    function unpauseAsset(address asset) external onlyAdminOrUnpauser {
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
