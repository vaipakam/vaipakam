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

    // ─── Phase 4: tier-LTV aggregation ────────────────────────────────────

    /// @notice Aggregate peer LTV readings across a reference asset
    ///         list to produce a per-tier consensus median.
    /// @dev    Two-stage aggregation:
    ///           1. Per-asset: collect LTVs from every available peer
    ///              (Aave + Compound; Morpho deferred to Phase 3.5).
    ///              Reject the asset's contribution if fewer than
    ///              `minPeerReadings` peers report, or if the spread
    ///              across reporting peers exceeds
    ///              `divergenceToleranceBps`. Otherwise take the
    ///              asset's median across peers.
    ///           2. Per-tier: median across all asset-medians. Reject
    ///              the whole tier if fewer than `minAssetReadings`
    ///              assets contributed.
    ///
    ///         All comparisons in BPS — no unit conversions in the
    ///         aggregator (the peer reads already normalised at the
    ///         library boundary).
    ///
    ///         Pure / view. No state in this library; the caller
    ///         (`OracleFacet.refreshTierLtvCache`) persists the result
    ///         and emits events.
    ///
    /// @param  aave  Aave V3 PoolDataProvider address. Zero ⇒ no Aave
    ///               reads for this aggregation.
    /// @param  comet Compound V3 Comet address. Zero ⇒ no Compound
    ///               reads.
    /// @param  refAssets Reference asset list for the tier being
    ///                   aggregated.
    /// @param  divergenceToleranceBps Per-asset divergence ceiling.
    /// @param  minPeerReadings        Minimum peers per asset.
    /// @param  minAssetReadings       Minimum assets per tier.
    /// @return ok                  `true` iff the aggregation produced
    ///                             a valid tier-median.
    /// @return tierMedianBps       Median across asset-medians, or 0
    ///                             when ok=false.
    /// @return assetsContributing  Count of reference assets that
    ///                             passed per-asset consensus and
    ///                             contributed to the tier median.
    function aggregateTierLtv(
        address aave,
        address comet,
        address[] memory refAssets,
        uint16 divergenceToleranceBps,
        uint8 minPeerReadings,
        uint8 minAssetReadings
    )
        internal
        view
        returns (bool ok, uint16 tierMedianBps, uint8 assetsContributing)
    {
        if (refAssets.length == 0) return (false, 0, 0);

        uint16[] memory assetMedians = new uint16[](refAssets.length);
        uint256 n;

        for (uint256 i = 0; i < refAssets.length; ++i) {
            (uint16 amed, bool aOk) = _perAssetMedian(
                aave,
                comet,
                refAssets[i],
                divergenceToleranceBps,
                minPeerReadings
            );
            if (aOk) {
                assetMedians[n++] = amed;
            }
        }

        if (n < uint256(minAssetReadings)) return (false, 0, uint8(n));

        // In-place insertion sort — n is small (typical ≤ 10), so the
        // O(n²) is fine. Median of n entries: n%2==1 ⇒ middle; n%2==0
        // ⇒ average of the two middle entries.
        for (uint256 i = 1; i < n; ++i) {
            uint16 key = assetMedians[i];
            uint256 j = i;
            while (j > 0 && assetMedians[j - 1] > key) {
                assetMedians[j] = assetMedians[j - 1];
                --j;
            }
            assetMedians[j] = key;
        }
        uint16 medianBps;
        if (n % 2 == 1) {
            medianBps = assetMedians[n / 2];
        } else {
            medianBps = uint16(
                (uint256(assetMedians[n / 2 - 1]) + uint256(assetMedians[n / 2])) / 2
            );
        }
        return (true, medianBps, uint8(n));
    }

    /// @dev Per-asset consensus: collect peer LTVs for one asset,
    ///      return the asset-median if `minPeerReadings` peers agree
    ///      within `divergenceToleranceBps`. The library currently
    ///      reads Aave + Compound; the Morpho peer is deferred to
    ///      Phase 3.5.
    function _perAssetMedian(
        address aave,
        address comet,
        address asset,
        uint16 divergenceToleranceBps,
        uint8 minPeerReadings
    ) private view returns (uint16 medianBps, bool ok) {
        uint16[] memory ltvs = new uint16[](2);
        uint256 p;

        (bool aOk, uint16 aLtv, ) = readAaveLtv(aave, asset);
        if (aOk) ltvs[p++] = aLtv;
        (bool cOk, uint16 cLtv, ) = readCometLtv(comet, asset);
        if (cOk) ltvs[p++] = cLtv;

        if (p < uint256(minPeerReadings)) return (0, false);

        // For p == 2 (current cap): spread = |a - b|; reject if it
        // exceeds the divergence tolerance, else median = average.
        // For p == 1: handled by the minPeerReadings >= 2 guard above
        // (single-peer doesn't satisfy consensus).
        uint16 hi = ltvs[0] > ltvs[1] ? ltvs[0] : ltvs[1];
        uint16 lo = ltvs[0] > ltvs[1] ? ltvs[1] : ltvs[0];
        if (hi - lo > divergenceToleranceBps) return (0, false);
        return (uint16((uint256(ltvs[0]) + uint256(ltvs[1])) / 2), true);
    }
}
