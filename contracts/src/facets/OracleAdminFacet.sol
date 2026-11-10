// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibPriceGuard} from "../libraries/LibPriceGuard.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IProtocolRegistryReader} from "../interfaces/IProtocolRegistryReader.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {RegistryKeys} from "../governance/RegistryKeys.sol";

/**
 * @title OracleAdminFacet
 * @notice Admin facet for the oracle settings the Diamond still holds: the
 *         pool factory and the peer-protocol and reference-asset inputs of
 *         the liquidity classification. It also records, once, the protocol
 *         registry through which the Diamond finds its price guard.
 * @dev    No price setting lives here (#3272 part 2). Every input of a price
 *         (feeds, the feed registry, WETH, staleness, the secondary sources,
 *         the Pyth cross-check, the sequencer feed) is the price guard's own
 *         config, changed under the guard's delay by its owner, the Timelock.
 *         The Diamond has no write path into it. Per README §1.5, liquidity
 *         classification is never manually overrideable: an asset passes the
 *         on-chain price and pool checks or is Illiquid.
 */
contract OracleAdminFacet is DiamondAccessControl {
    /// @notice {initializeProtocolRegistry} was given an address with no
    ///         code, or a registry that names no price guard.
    error ProtocolRegistryMismatch(address registry);

    /// @notice {initializeProtocolRegistry} was already called.
    error AlreadyInitialized();

    /// @notice Emitted once, when the deploy records the protocol registry
    ///         and, from its price guard, the numeraire the Diamond keeps.
    /// @custom:event-category informational/config
    event ProtocolRegistrySet(address indexed registry, bytes32 numeraireSymbol);

    // ─── Bound-related errors (post-audit hardening, 2026-05-14) ──────
    // `setTierReferenceAssets` accepted an unbounded array (hot-path-cost
    // vector) until `docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`.

    /// @notice `setTierReferenceAssets.assets` exceeded
    ///         MAX_TIER_REFERENCE_ASSETS (20). The cache-refresh
    ///         iteration is O(assets × peers) on the hot path; an
    ///         unbounded list would let a single config call DoS the
    ///         permissionless refresh.
    error TierReferenceAssetsTooLong(uint256 length, uint256 maxLength);

    /// @dev See {TierReferenceAssetsTooLong}. 20 leaves headroom over
    ///      today's 4-asset Tier-3 reference set without permitting
    ///      a 1000-asset hot-path-DoS vector.
    uint256 internal constant MAX_TIER_REFERENCE_ASSETS = 20;

    /**
     * @notice Sets the v3-style AMM factory used by
     *         `OracleFacet.checkLiquidity` for pool discovery.
     * @dev Owner-only. Setting to `address(0)` collapses the liquidity
     *      classification to Illiquid for every asset (fail-closed).
     * @param factory The v3-style AMM factory contract address.
     */
    function setUniswapV3Factory(address factory) external {
        LibVaipakam.setUniswapV3Factory(factory);
    }

    // ─── #3272 part 2 — where the Diamond finds its price guard ─────────

    /**
     * @notice Records the protocol registry through which the Diamond finds
     *         its price guard (pointer `RegistryKeys.PRICE_GUARD`). One-shot,
     *         at deploy.
     * @dev    ADMIN_ROLE-only. The registry must have code and already name a
     *         guard, so a Diamond is never left pointing at a registry that
     *         prices nothing. The guard's numeraire is recorded with it: every
     *         numeraire-denominated threshold the Diamond holds is in that
     *         unit, and a guard swapped in later must price in it too
     *         ({LibPriceGuard.guard}). Which guard the Diamond reads is then
     *         decided by the registry (Timelock-owned, its pointer swap
     *         delayed and cancellable by the guardian), never by Diamond
     *         storage.
     * @param  registry The chain's `ProtocolRegistry`.
     */
    function initializeProtocolRegistry(address registry)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        if (s.protocolRegistry != address(0)) revert AlreadyInitialized();
        if (registry.code.length == 0) revert ProtocolRegistryMismatch(registry);
        bytes32 numeraire;
        try IProtocolRegistryReader(registry).pointer(RegistryKeys.PRICE_GUARD) returns (address g) {
            if (g.code.length == 0) revert ProtocolRegistryMismatch(registry);
            numeraire = IPriceGuard(g).NUMERAIRE_SYMBOL();
        } catch {
            revert ProtocolRegistryMismatch(registry);
        }
        s.protocolRegistry = registry;
        s.numeraireSymbol = numeraire;
        emit ProtocolRegistrySet(registry, numeraire);
    }

    /// @notice The protocol registry the Diamond records; zero until the
    ///         deploy records one.
    function getProtocolRegistry() external view returns (address) {
        return LibVaipakam.storageSlot().protocolRegistry;
    }

    /// @notice The price guard every price the Diamond reads comes from: the
    ///         registry's `PRICE_GUARD` pointer now. Its config (feeds,
    ///         sources, staleness, the delay) is read from the guard itself.
    /// @dev    Reverts until the registry is recorded.
    function getPriceGuard() external view returns (address) {
        return address(LibPriceGuard.guard());
    }

    /**
     * @notice Configure the per-chain peer-lending-protocol addresses
     *         the autonomous tier-LTV cache reads. Phase 3 of
     *         AutonomousLtvAndOracleFallback.md.
     * @dev    Owner-only (TimelockController post-handover, so 48h-gated).
     *         Setting any to `address(0)` skips that peer in the
     *         aggregation — fine for chains where the peer isn't
     *         deployed. Addresses must be verified against each
     *         protocol's official docs before this call; the on-chain
     *         layer doesn't validate provenance.
     *
     *         Verification examples per peer:
     *           - Aave V3 PoolDataProvider — per-chain address from
     *             https://aave.com/docs/resources/addresses (chain-
     *             specific deployment).
     *           - Compound V3 Comet — one Comet per base asset; pick
     *             the largest by liquidity on the target chain. From
     *             https://docs.compound.finance/#networks.
     *           - Morpho-Blue — single deployment per chain. From
     *             https://docs.morpho.org. (For v1, this slot is
     *             read but the Morpho aggregator is a Phase-3.5
     *             follow-up — the address can be set early so the
     *             registry is ready when the reader lands.)
     *
     * @param aaveV3PoolDataProvider Aave V3 data-provider, or zero.
     * @param compoundV3Comet        Compound V3 Comet (one), or zero.
     * @param morphoBlue             Morpho-Blue contract, or zero.
     */
    function setPeerProtocolAddresses(
        address aaveV3PoolDataProvider,
        address compoundV3Comet,
        address morphoBlue
    ) external {
        LibVaipakam.setPeerProtocolAddresses(
            aaveV3PoolDataProvider,
            compoundV3Comet,
            morphoBlue
        );
    }

    /// @notice Read the configured peer-protocol addresses for this
    ///         chain. Single-call view that returns the full triple,
    ///         shaped to feed the protocol-console + the audit-package
    ///         per-chain verification step.
    function getPeerProtocolAddresses()
        external
        view
        returns (
            address aaveV3PoolDataProvider,
            address compoundV3Comet,
            address morphoBlue
        )
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        return (s.aaveV3PoolDataProvider, s.compoundV3Comet, s.morphoBlue);
    }

    /**
     * @notice Set a tier's reference asset list. Phase 4 of
     *         AutonomousLtvAndOracleFallback.md. Constitution-level
     *         setting: changes are rare, governance-gated, and require
     *         re-audit of the new asset list for collateral suitability.
     * @dev    Owner-only (TimelockController post-handover, 48h-gated).
     *         An empty array clears the tier — refreshes for that tier
     *         then emit `no-reference-assets` and the cache stays at
     *         its previous value (or library default if hard-stale).
     *
     *         Recommended reference lists per tier (per-chain — the
     *         operator picks each chain's canonical token addresses):
     *           Tier 3 (deepest, blue-chip): WBTC, WETH, USDC, USDT, DAI
     *           Tier 2 (mid-cap):            LINK, AAVE, UNI, COMP, MKR
     *           Tier 1 (entry):              a small list of well-attested mid/long-tail
     *
     *         The aggregator (`OracleFacet.refreshTierLtvCache`) reads
     *         these assets' LTVs from each configured peer, applies
     *         per-asset + per-tier consensus, applies the tier's
     *         haircut, bound-checks, and persists. The list itself is
     *         constitution-level: changing it doesn't auto-trigger a
     *         refresh; operators call `refreshTierLtvCache()` after
     *         updating the list to pick up the new asset universe.
     * @param  tier   1, 2, or 3.
     * @param  assets New reference asset list for this tier. Pass an
     *                empty array to clear.
     */
    function setTierReferenceAssets(uint8 tier, address[] calldata assets) external {
        // Gap #3 from the 2026-05-14 bounds audit
        // (`docs/internal/ConfigKnobBoundsAudit-2026-05-14.md`):
        // `refreshTierLtvCache`'s hot-path iterates O(assets × peers).
        // Without a cap, a single config call could push 1000+ assets
        // per tier and DoS the permissionless refresh. 20 leaves
        // headroom over today's 4-asset Tier-3 reference set without
        // permitting griefing.
        if (assets.length > MAX_TIER_REFERENCE_ASSETS) {
            revert TierReferenceAssetsTooLong(
                assets.length,
                MAX_TIER_REFERENCE_ASSETS
            );
        }
        // Convert calldata to memory once (LibVaipakam takes memory[]).
        address[] memory mem = new address[](assets.length);
        for (uint256 i = 0; i < assets.length; ++i) mem[i] = assets[i];
        LibVaipakam.setTierReferenceAssets(tier, mem);
    }

    /// @notice Read a tier's reference asset list. Single-call view
    ///         that returns the full array, shaped to feed the
    ///         protocol-console + the audit-package per-chain
    ///         verification step.
    function getTierReferenceAssets(uint8 tier)
        external
        view
        returns (address[] memory)
    {
        return LibVaipakam.getTierReferenceAssets(tier);
    }
}
