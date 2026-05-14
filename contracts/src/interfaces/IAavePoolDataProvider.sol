// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IAavePoolDataProvider
 * @notice Minimal Aave V3 data-provider interface — only the
 *         `getReserveConfigurationData` call needed by `LibPeerLTV` for
 *         the autonomous tier-LTV cache (Phase 3 of
 *         AutonomousLtvAndOracleFallback.md).
 *
 * @dev    Per Aave V3's PoolDataProvider contract — deployed to a
 *         well-known address per chain. The full interface is far
 *         larger (reserve totals, user data, interest-rate strategies,
 *         etc.); this file imports only the call we read on-chain.
 *
 *         `ltv` and `liquidationThreshold` are returned in BPS
 *         (e.g. 7800 for 78%) — same scale Vaipakam uses internally,
 *         so no conversion is needed at the library boundary.
 *
 *         An asset that isn't listed on Aave on this chain returns
 *         all-zero values without reverting; `LibPeerLTV` checks
 *         `ltv > 0` (and other freshness conditions) to detect that
 *         case and skip the asset's contribution to the peer median.
 *
 *         The protocol's pause / freeze state surfaces via `isActive`
 *         and `isFrozen` — `LibPeerLTV` may opt to exclude frozen
 *         reserves from the median to avoid pegging our LTV to a
 *         peer state that's itself in distress.
 */
interface IAavePoolDataProvider {
    function getReserveConfigurationData(address asset)
        external
        view
        returns (
            uint256 decimals,
            uint256 ltv,
            uint256 liquidationThreshold,
            uint256 liquidationBonus,
            uint256 reserveFactor,
            bool usageAsCollateralEnabled,
            bool borrowingEnabled,
            bool stableBorrowRateEnabled,
            bool isActive,
            bool isFrozen
        );
}
