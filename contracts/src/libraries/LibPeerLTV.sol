// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IAavePoolDataProvider} from "../interfaces/IAavePoolDataProvider.sol";
import {IComet} from "../interfaces/IComet.sol";

/**
 * @title LibPeerLTV
 * @notice Read primitives for the autonomous tier-LTV cache (Phase 3
 *         of AutonomousLtvAndOracleFallback.md). Pure / view; no state
 *         in this library. Phase 4 will consume these primitives via
 *         `refreshTierLtvCache` to aggregate per-tier medians + bound-
 *         check + persist to storage.
 *
 *         Each `read*` returns `(bool ok, uint16 ltvBps, uint16 liqThresholdBps)`:
 *           - `ok = false` ⇒ the peer doesn't list the asset on this
 *             chain (or the peer protocol itself isn't deployed —
 *             caller passes `address(0)` for that case).
 *           - `ok = true` ⇒ a valid reading; the aggregator includes
 *             it in the per-asset median.
 *
 *         All reads use low-level `staticcall` + `abi.decode` rather
 *         than direct interface calls — handles the "asset not listed"
 *         case for protocols (Compound V3 in particular) that REVERT
 *         on unlisted assets, without the revert bubbling up and
 *         killing the whole refresh tx.
 *
 *         Output normalisation: everything reported in BPS (0-10_000).
 *         Aave's data provider returns BPS directly. Compound V3's
 *         `borrowCollateralFactor` is 1e18-scaled — converted here by
 *         multiplying by 10_000 / 1e18 (= dividing by 1e14).
 *
 *         Per-asset checks the library applies INSIDE each read:
 *           - Asset listed (peer-specific signal).
 *           - Asset not frozen / not paused (peer-specific signal —
 *             Aave's `isActive && !isFrozen`).
 *           - LTV in plausible band (1 ≤ ltv ≤ 9_900); rejects
 *             obvious garbage from a malformed peer state.
 *
 *         Per-asset checks the AGGREGATOR (Phase 4) applies AFTER the
 *         library returns:
 *           - Multi-peer consensus per asset (≥ 2 peers report within
 *             `PEER_DIVERGENCE_TOLERANCE`).
 *           - Multi-asset stability per tier (≥ 2 reference assets
 *             reporting; tier median over those).
 *           - Per-tier bound enforcement (final value in `[floor, ceil]`).
 */
library LibPeerLTV {
    /// @dev Plausibility bounds for a peer-reported LTV. Below 1 BPS
    ///      almost certainly means "not listed" reported as 0; above
    ///      99% is implausible for any real lending protocol's safe LTV.
    ///      Library-side guards complement the Phase-4 per-tier bound
    ///      check (which is the actual safety floor / ceiling per tier).
    uint16 internal constant MIN_PLAUSIBLE_LTV_BPS = 1;
    uint16 internal constant MAX_PLAUSIBLE_LTV_BPS = 9_900;

    /// @dev Compound V3 returns CFs as `1e18 × fraction` in `uint64`.
    ///      `(cf × 10_000) / 1e18 = cf / 1e14` gives BPS. uint64 caps at
    ///      ~1.8e19 so values < 1e18 (every realistic CF) round-trip safely.
    uint256 internal constant COMET_FACTOR_TO_BPS_DIVISOR = 1e14;

    /// @notice Read an asset's risk parameters from an Aave V3
    ///         PoolDataProvider on this chain.
    /// @param  provider The Aave V3 PoolDataProvider address. Pass
    ///                  `address(0)` to short-circuit (peer not
    ///                  deployed on this chain).
    /// @param  asset    The collateral asset.
    /// @return ok                 `true` iff the asset is listed,
    ///                            active, not frozen, and the read
    ///                            decoded cleanly.
    /// @return ltvBps             Borrowable LTV in BPS (returned from
    ///                            Aave already in BPS).
    /// @return liqThresholdBps    Liquidation threshold in BPS.
    function readAaveLtv(address provider, address asset)
        internal
        view
        returns (bool ok, uint16 ltvBps, uint16 liqThresholdBps)
    {
        if (provider == address(0) || asset == address(0)) return (false, 0, 0);

        // Low-level staticcall — avoids reverting the whole refresh
        // tx if the address isn't actually a PoolDataProvider, the
        // ABI doesn't match, or the asset's reserve is in a weird state.
        (bool success, bytes memory data) = provider.staticcall(
            abi.encodeWithSelector(
                IAavePoolDataProvider.getReserveConfigurationData.selector,
                asset
            )
        );
        // Aave returns 4× uint256 + 5× bool — 4×32 + 5×32 = 288 bytes
        // (bools pad to 32 bytes each in ABI encoding). Add the 2
        // leading uint256s (decimals + reserveFactor not in the list
        // above — see the interface) → 10 fields × 32 = 320 bytes.
        if (!success || data.length < 320) return (false, 0, 0);

        (
            ,                               // decimals (skipped)
            uint256 ltv,
            uint256 liquidationThreshold,
            ,                               // liquidationBonus (skipped)
            ,                               // reserveFactor (skipped)
            ,                               // usageAsCollateralEnabled
            ,                               // borrowingEnabled
            ,                               // stableBorrowRateEnabled
            bool isActive,
            bool isFrozen
        ) = abi.decode(
            data,
            (uint256, uint256, uint256, uint256, uint256, bool, bool, bool, bool, bool)
        );

        if (!isActive || isFrozen) return (false, 0, 0);
        if (
            ltv < MIN_PLAUSIBLE_LTV_BPS ||
            ltv > MAX_PLAUSIBLE_LTV_BPS ||
            liquidationThreshold < MIN_PLAUSIBLE_LTV_BPS ||
            liquidationThreshold > MAX_PLAUSIBLE_LTV_BPS
        ) {
            return (false, 0, 0);
        }
        return (true, uint16(ltv), uint16(liquidationThreshold));
    }

    /// @notice Read an asset's risk parameters from a Compound V3
    ///         Comet on this chain.
    /// @param  comet The Comet contract address (one Comet per base
    ///               asset — cUSDCv3, cUSDTv3, cWETHv3, ...). Pass
    ///               `address(0)` to short-circuit.
    /// @param  asset The collateral asset.
    /// @return ok                 `true` iff the asset is a listed
    ///                            collateral on this Comet and the
    ///                            read decoded cleanly.
    /// @return ltvBps             `borrowCollateralFactor` normalised
    ///                            to BPS — Compound's equivalent of
    ///                            Aave's "ltv" (the borrowable
    ///                            collateralisation factor).
    /// @return liqThresholdBps    `liquidateCollateralFactor`
    ///                            normalised to BPS — Compound's
    ///                            equivalent of Aave's
    ///                            "liquidationThreshold".
    function readCometLtv(address comet, address asset)
        internal
        view
        returns (bool ok, uint16 ltvBps, uint16 liqThresholdBps)
    {
        if (comet == address(0) || asset == address(0)) return (false, 0, 0);

        // Compound V3 REVERTS if the asset isn't a registered
        // collateral on this Comet. staticcall+success-check catches
        // that without bubbling the revert.
        (bool success, bytes memory data) = comet.staticcall(
            abi.encodeWithSelector(IComet.getAssetInfoByAddress.selector, asset)
        );
        // AssetInfo = (uint8, address, address, uint64, uint64, uint64,
        // uint64, uint128). 8 fields × 32 bytes = 256 bytes minimum
        // (Solidity ABI pads each field to a full word).
        if (!success || data.length < 256) return (false, 0, 0);

        IComet.AssetInfo memory info = abi.decode(data, (IComet.AssetInfo));

        // Sanity: the returned struct's `asset` field must match the
        // queried address — defends against a peer state where
        // getAssetInfoByAddress somehow returns a struct for a
        // different asset.
        if (info.asset != asset) return (false, 0, 0);

        // Convert 1e18-scaled CFs to BPS.
        uint256 borrowBps = uint256(info.borrowCollateralFactor) /
            COMET_FACTOR_TO_BPS_DIVISOR;
        uint256 liquidateBps = uint256(info.liquidateCollateralFactor) /
            COMET_FACTOR_TO_BPS_DIVISOR;

        if (
            borrowBps < MIN_PLAUSIBLE_LTV_BPS ||
            borrowBps > MAX_PLAUSIBLE_LTV_BPS ||
            liquidateBps < MIN_PLAUSIBLE_LTV_BPS ||
            liquidateBps > MAX_PLAUSIBLE_LTV_BPS
        ) {
            return (false, 0, 0);
        }
        return (true, uint16(borrowBps), uint16(liquidateBps));
    }
}
