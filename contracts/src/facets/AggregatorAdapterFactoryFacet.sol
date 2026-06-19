// src/facets/AggregatorAdapterFactoryFacet.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {DiamondReentrancyGuard} from "../libraries/LibReentrancyGuard.sol";
import {DiamondPausable} from "../libraries/LibPausable.sol";
import {AggregatorAdapterImplementation} from "../AggregatorAdapterImplementation.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title  AggregatorAdapterFactoryFacet
 * @author Vaipakam Developer Team
 * @notice #398 / #401 v1.5 — provisions + version-manages the per-aggregator
 *         ERC-4626 lender adapters (`AggregatorAdapterImplementation`). Mirrors
 *         `VaultFactoryFacet`'s shared-UUPS-impl + per-instance-proxy +
 *         version-registry pattern:
 *
 *           - governance PUBLISHES the shared impl (`initializeAdapterImplementation`
 *             / `upgradeAdapterImplementation`, bumping `currentAdapterVersion`);
 *           - governance PROVISIONS a per-aggregator proxy
 *             (`createAggregatorAdapter`) — aggregator onboarding is curated (the
 *             keeper + risk bounds are a partnership decision), so it is
 *             VAULT_ADMIN-gated, unlike the permissionless per-user vault;
 *           - the aggregator PULLS a migration (`upgradeAggregatorAdapter`,
 *             permissionless trigger) — no silent behaviour change under a live
 *             integration; the Diamond owns the proxy so it mediates the UUPS
 *             `upgradeToAndCall`;
 *           - governance can MANDATE a floor (`setMandatoryAdapterUpgrade`) to
 *             force a critical fix (upgrade-or-halt), reserved for security.
 *
 *         Each adapter is itself a Vaipakam lender (its own per-user vault +
 *         `LenderIntent`); E1 single-principal lives in the adapter. See
 *         docs/DesignsAndPlans/AggregatorAdapterV15Design.md.
 */
contract AggregatorAdapterFactoryFacet is
    DiamondReentrancyGuard,
    DiamondPausable,
    DiamondAccessControl
{
    /// @notice The shared adapter implementation was published / upgraded.
    event AdapterImplementationUpgraded(
        address indexed oldImplementation,
        address indexed newImplementation,
        uint256 indexed newVersion
    );
    /// @notice A per-aggregator adapter proxy was provisioned.
    event AggregatorAdapterCreated(
        address indexed authorizedPrincipal,
        address indexed adapter,
        address indexed lendingAsset,
        address collateralAsset
    );
    /// @notice An aggregator migrated its adapter proxy to the current impl.
    event AggregatorAdapterUpgraded(
        address indexed adapter,
        uint256 indexed newVersion
    );
    /// @notice The mandatory adapter-version floor was set.
    event MandatoryAdapterUpgradeSet(uint256 indexed version);
    /// @notice An adapter's NAV haircut was updated via governance.
    event AggregatorAdapterHaircutSet(address indexed adapter, uint16 bps);

    /// @notice The shared adapter implementation has not been initialized.
    error AdapterTemplateNotSet();
    /// @notice The shared adapter implementation is already initialized.
    error AdapterAlreadyInitialized();
    /// @notice The address is not a factory-deployed aggregator adapter.
    error NotAnAggregatorAdapter();
    /// @notice The #398 aggregator-adapter feature is paused by governance (#633).
    error AggregatorAdaptersPaused();
    /// @notice The UUPS upgrade call on the adapter proxy reverted.
    error AdapterUpgradeFailed();
    /// @notice A voluntary (non-mandated) adapter migration was attempted by
    ///         someone other than the adapter's authorized principal.
    error NotAdapterPrincipal();

    /**
     * @notice One-time deploy of the shared adapter implementation.
     * @dev VAULT_ADMIN_ROLE-only. Sets `aggregatorAdapterTemplate`;
     *      `currentAdapterVersion` stays 0 until the first
     *      {upgradeAdapterImplementation} (mirrors the vault factory).
     */
    function initializeAdapterImplementation()
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.aggregatorAdapterTemplate != address(0)) {
            revert AdapterAlreadyInitialized();
        }
        s.aggregatorAdapterTemplate = address(
            new AggregatorAdapterImplementation()
        );
    }

    /**
     * @notice Provision a per-aggregator ERC-4626 adapter (curated onboarding).
     * @dev VAULT_ADMIN_ROLE-only. Deploys an ERC1967Proxy over the shared impl
     *      and initializes it; the adapter then registers its keeper-gated
     *      intent + authorizes `keeper` for fills + auto-roll. Returns the
     *      adapter address.
     * @param principal           The single authorized aggregator (deposits +
     *                            sole share holder).
     * @param lendingAsset        ERC-4626 underlying = the asset lent.
     * @param collateralAsset     The collateral the adapter's intent accepts.
     * @param haircutBps          Initial NAV haircut on live principal.
     * @param keeper              Designated keeper (fills + auto-rolls).
     * @param name                ERC-20 share name.
     * @param symbol              ERC-20 share symbol.
     * @param intentMaxExposure   Intent bound: max live principal at once.
     * @param intentMinRateBps    Intent bound: APR floor.
     * @param intentMaxInitLtvBps Intent bound: init-LTV ceiling.
     * @param intentMaxDurationDays Intent bound: longest term.
     * @param intentMinFillAmount Intent bound: smallest slice.
     */
    function createAggregatorAdapter(
        address principal,
        address lendingAsset,
        address collateralAsset,
        uint16 haircutBps,
        address keeper,
        string calldata name,
        string calldata symbol,
        uint256 intentMaxExposure,
        uint256 intentMinRateBps,
        uint16 intentMaxInitLtvBps,
        uint32 intentMaxDurationDays,
        uint256 intentMinFillAmount
    )
        external
        whenNotPaused
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
        returns (address adapter)
    {
        // NOTE: intentionally NOT `nonReentrant`. The Diamond's reentrancy guard
        // is a single shared lock; this function deploys the adapter, whose
        // `initialize` immediately calls back into the Diamond
        // (`setLenderIntent` / `setKeeperAccess` / `approveKeeper`, themselves
        // guarded). Holding the lock here would make those callbacks revert.
        // Safe to omit: VAULT_ADMIN-gated, moves no funds, and the callbacks
        // target trusted intent/profile facets that never re-enter this factory.
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        // #633 — governance kill-switch: freeze new-adapter onboarding when the
        // aggregator feature is paused (fills are gated in `matchIntent`).
        if (LibVaipakam.cfgAggregatorAdaptersPaused()) {
            revert AggregatorAdaptersPaused();
        }
        if (s.aggregatorAdapterTemplate == address(0)) {
            revert AdapterTemplateNotSet();
        }
        bytes memory data = abi.encodeCall(
            AggregatorAdapterImplementation.initialize,
            (
                s.diamondAddress,
                principal,
                lendingAsset,
                collateralAsset,
                haircutBps,
                keeper,
                name,
                symbol,
                intentMaxExposure,
                intentMinRateBps,
                intentMaxInitLtvBps,
                intentMaxDurationDays,
                intentMinFillAmount
            )
        );
        adapter = address(
            new ERC1967Proxy(s.aggregatorAdapterTemplate, data)
        );
        s.isAggregatorAdapter[adapter] = true;
        s.adapterVersion[adapter] = s.currentAdapterVersion;
        emit AggregatorAdapterCreated(
            principal,
            adapter,
            lendingAsset,
            collateralAsset
        );
    }

    /**
     * @notice Publish a new shared adapter implementation.
     * @dev VAULT_ADMIN_ROLE-only. Existing adapter proxies keep the old impl
     *      until each aggregator calls {upgradeAggregatorAdapter}, unless
     *      {setMandatoryAdapterUpgrade} forces it. Bumps `currentAdapterVersion`.
     */
    function upgradeAdapterImplementation(address newImplementation)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        if (newImplementation.code.length == 0) revert AdapterUpgradeFailed();
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        address oldImpl = s.aggregatorAdapterTemplate;
        s.aggregatorAdapterTemplate = newImplementation;
        unchecked {
            ++s.currentAdapterVersion;
        }
        emit AdapterImplementationUpgraded(
            oldImpl,
            newImplementation,
            s.currentAdapterVersion
        );
    }

    /**
     * @notice Migrate an adapter proxy to the current shared impl.
     * @dev Aggregator-PULL: a *voluntary* migration is gated to the adapter's
     *      authorized principal — so behaviour can't change under a live ERC-4626
     *      integration without the aggregator opting in (#626 round-2 P2). The
     *      exception is a *mandated* migration: when the adapter is below
     *      `mandatoryAdapterVersion`, anyone may force it (the upgrade-or-halt
     *      backstop, so a critical fix can be pushed even if the aggregator
     *      stalls). The Diamond owns the proxy (UUPS `_authorizeUpgrade` is
     *      `onlyOwner`), so this call — from the Diamond's context — authorizes
     *      the upgrade.
     */
    function upgradeAggregatorAdapter(address adapter) external {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.isAggregatorAdapter[adapter]) revert NotAnAggregatorAdapter();
        bool mandated = s.mandatoryAdapterVersion > 0 &&
            s.adapterVersion[adapter] < s.mandatoryAdapterVersion;
        if (
            !mandated &&
            msg.sender !=
            AggregatorAdapterImplementation(adapter).authorizedPrincipal()
        ) {
            revert NotAdapterPrincipal();
        }
        (bool success, ) = adapter.call(
            abi.encodeWithSelector(
                UUPSUpgradeable.upgradeToAndCall.selector,
                s.aggregatorAdapterTemplate,
                ""
            )
        );
        if (!success) revert AdapterUpgradeFailed();
        s.adapterVersion[adapter] = s.currentAdapterVersion;
        emit AggregatorAdapterUpgraded(adapter, s.currentAdapterVersion);
    }

    /**
     * @notice Set the minimum adapter version; below it, the adapter's own ops
     *         should treat themselves as upgrade-required (the adapter reads
     *         this floor — reserved for critical fixes, timelock-gated).
     * @dev VAULT_ADMIN_ROLE-only.
     */
    function setMandatoryAdapterUpgrade(uint256 version)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.storageSlot().mandatoryAdapterVersion = version;
        emit MandatoryAdapterUpgradeSet(version);
    }

    /**
     * @notice Governance update of an adapter's NAV haircut on live principal.
     * @dev VAULT_ADMIN_ROLE-only. Calls the adapter's owner-gated setter; the
     *      adapter's owner is the Diamond, so this call (from the Diamond's
     *      context) is authorized.
     */
    function setAggregatorHaircutBps(address adapter, uint16 bps)
        external
        onlyRole(LibAccessControl.VAULT_ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (!s.isAggregatorAdapter[adapter]) revert NotAnAggregatorAdapter();
        AggregatorAdapterImplementation(adapter).setHaircutBps(bps);
        emit AggregatorAdapterHaircutSet(adapter, bps);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    function aggregatorAdapterTemplate() external view returns (address) {
        return LibVaipakam.storageSlot().aggregatorAdapterTemplate;
    }

    function currentAggregatorAdapterVersion() external view returns (uint256) {
        return LibVaipakam.storageSlot().currentAdapterVersion;
    }

    function mandatoryAggregatorAdapterVersion()
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().mandatoryAdapterVersion;
    }

    function getAggregatorAdapterVersion(address adapter)
        external
        view
        returns (uint256)
    {
        return LibVaipakam.storageSlot().adapterVersion[adapter];
    }

    function isAggregatorAdapter(address adapter)
        external
        view
        returns (bool)
    {
        return LibVaipakam.storageSlot().isAggregatorAdapter[adapter];
    }
}
