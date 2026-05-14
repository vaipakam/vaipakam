// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title IComet
 * @notice Minimal Compound V3 Comet interface — only the
 *         `getAssetInfoByAddress` call needed by `LibPeerLTV` for the
 *         autonomous tier-LTV cache (Phase 3 of
 *         AutonomousLtvAndOracleFallback.md).
 *
 * @dev    Per Compound V3's Comet contract — one Comet per base asset
 *         (cUSDCv3 / cUSDTv3 / cWETHv3 / cWBTCv3 / ...). Each Comet
 *         lists a set of *collateral* assets with per-asset risk
 *         parameters. To get a complete picture across the protocol,
 *         the aggregator (Phase 4) reads across each Comet's collateral
 *         list.
 *
 *         Returns `borrowCollateralFactor` and `liquidateCollateralFactor`
 *         in 1e18 scale (e.g. `0.85e18` for 85% borrow CF). `LibPeerLTV`
 *         normalises these to BPS so the aggregation uses a uniform
 *         scale across peers.
 *
 *         `getAssetInfoByAddress` REVERTS if the asset isn't listed as
 *         a collateral on this Comet. `LibPeerLTV` uses low-level
 *         `staticcall` + `success` check to detect and skip the
 *         non-listed case without bubbling the revert.
 */
interface IComet {
    struct AssetInfo {
        uint8 offset;
        address asset;
        address priceFeed;
        uint64 scale;
        uint64 borrowCollateralFactor;     // 1e18 scale
        uint64 liquidateCollateralFactor;  // 1e18 scale
        uint64 liquidationFactor;          // 1e18 scale
        uint128 supplyCap;
    }

    /// @dev Reverts if `asset` isn't a registered collateral on this Comet.
    function getAssetInfoByAddress(address asset)
        external
        view
        returns (AssetInfo memory);
}
