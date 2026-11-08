// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {LibNumeraireValue} from "../libraries/LibNumeraireValue.sol";
import {OracleFacet} from "./OracleFacet.sol";

/**
 * @title SaleFloorFacet
 * @author Vaipakam Developer Team
 * @notice #3359 — the one rule for how much a forced sale of collateral may
 *         lose to the market (its slippage floor), and the hourly price
 *         checkpoints that rule reads.
 *
 *         Every forced sale used to accept up to the full
 *         `cfgMaxLiquidationSlippageBps` (6%) on every asset. That leaves
 *         room for a searcher to take up to 6% of a deep, calm sale that the
 *         market would fill for far less, and the borrower bears it. The
 *         rule here tightens the floor only where the sale is safe to
 *         tighten (owner decision 2026-11-08, "Balanced"):
 *         - the collateral clears a deep probe as a close-out measures it
 *           (OracleFacet.getCloseOutLiquidityTier): tier 3 ($5M at <=2%
 *           impact) 2.5%, tier 2 ($500k) 3.5%, tier 1 ($50k) 4.5%;
 *         - the pair is calm: its oracle rate now is within 2% of the rate
 *           at BOTH of the last two hourly checkpoints, so the look-back is
 *           always at least one hour;
 *         - the collateral is worth at least 110% of the debt at the oracle.
 *         If any of those fails, or cannot be established (no checkpoint,
 *         shallow depth), the floor is the full cap at once. So a missing
 *         input can only return the sale to today's 6%, never tighten it,
 *         and a sale that a moving market needs room for always gets it.
 *
 *         What this does NOT change: the liquidator bonus (fixed, owner
 *         decision 2026-11-07), the failed-swap retry floor
 *         (FallbackCustodyFacet), and the swap-to-repay floor (the
 *         borrower's own sale).
 *
 * @dev    Read through a Diamond self-call by every forced seller, so the
 *         rule exists once: ForcedSaleFacet (sizing and the minimum output)
 *         and RiskFacet's partial liquidation. The checkpoint writer is
 *         permissionless (it stores only the oracle's own reading, first
 *         caller per asset per hour) and is backed by a keeper pass that
 *         ships disarmed; until it runs, every sale uses the full cap.
 */
contract SaleFloorFacet is DiamondAccessControl {
    /// @notice Why a sale got the floor it got.
    /// @dev    Tight: every condition held, the tier figure applies.
    ///         Shallow: the collateral did not clear the $50k close-out probe.
    ///         NoCheckpoint: either asset lacks one of the last two hourly
    ///         checkpoints. Moving: the pair's rate moved more than the calm
    ///         bound against a checkpoint. ThinCushion: the collateral is
    ///         worth less than the cushion share of the debt (or the debt is
    ///         zero). Unpriced: a current price could not be read.
    enum FloorReason {
        Tight,
        Shallow,
        NoCheckpoint,
        Moving,
        ThinCushion,
        Unpriced
    }

    /// @notice The floor a forced sale gets.
    /// @param bps    The most the sale may lose to the market, in bps of the
    ///               oracle value of what it sells.
    /// @param tier   The collateral's close-out depth tier (0..3).
    /// @param reason Why (see {FloorReason}).
    struct SaleFloor {
        uint256 bps;
        uint8 tier;
        FloorReason reason;
    }

    /// @notice An hourly price checkpoint was recorded.
    /// @custom:event-category informational/config
    event HourlyPriceCheckpointed(address indexed asset, uint256 indexed hourIndex, uint256 price1e18);

    /// @notice Governance changed the forced-sale floor settings. Every
    ///         figure is the one now in effect (a default where unset).
    /// @custom:event-category state-change/risk-config
    event SaleFloorConfigSet(
        uint16 tier1Bps,
        uint16 tier2Bps,
        uint16 tier3Bps,
        uint16 calmMoveBps,
        uint16 cushionBps
    );

    // ─── Checkpoints ─────────────────────────────────────────────────────

    /// @notice Record each asset's oracle price for the current UTC hour.
    /// @dev    Anyone may call. The first caller in an hour sets that hour's
    ///         checkpoint; later calls in the same hour skip it. A price that
    ///         cannot be read (stale, divergent, missing) is skipped, so the
    ///         hour stays open for a later caller and a batch never fails on
    ///         one asset. The stored figure is the oracle's own reading
    ///         ({OracleFacet.getAssetPrice}), scaled to 1e18; a caller
    ///         chooses only WHEN in the hour it is taken, and the calm test
    ///         compares against two hours so no single timing choice decides it.
    /// @param  assets The assets to checkpoint.
    function checkpointHourlyPrices(address[] calldata assets) external {
        mapping(address => mapping(uint256 => uint256)) storage book =
            LibVaipakam.storageSlot().hourlyPrice1e18;
        uint256 hour = block.timestamp / 1 hours;
        for (uint256 i; i < assets.length; ++i) {
            address asset = assets[i];
            if (asset == address(0) || book[asset][hour] != 0) continue;
            (bool ok, uint256 p) = _price1e18(asset);
            if (!ok) continue;
            book[asset][hour] = p;
            emit HourlyPriceCheckpointed(asset, hour, p);
        }
    }

    /// @notice The checkpoint for `asset` in UTC hour `hourIndex`
    ///         (`timestamp / 3600`), 1e18-scaled; 0 = none recorded.
    function getHourlyPriceCheckpoint(address asset, uint256 hourIndex) external view returns (uint256) {
        return LibVaipakam.storageSlot().hourlyPrice1e18[asset][hourIndex];
    }

    // ─── The rule ────────────────────────────────────────────────────────

    /**
     * @notice The slippage floor for a forced sale of `collateralAmount` of
     *         `collateralAsset` against a debt of `debt` in `principalAsset`.
     * @dev    Never above `cfgMaxLiquidationSlippageBps`: a tier figure above
     *         a lowered cap reads as the cap.
     * @return f The floor, the tier read and the reason.
     */
    function saleFloorBps(
        address collateralAsset,
        address principalAsset,
        uint256 collateralAmount,
        uint256 debt
    ) external view returns (SaleFloor memory f) {
        uint256 cap = LibVaipakam.cfgMaxLiquidationSlippageBps();
        f.bps = cap;
        LibVaipakam.SaleFloorConfig memory c = LibVaipakam.cfgSaleFloor();

        f.tier = OracleFacet(address(this)).getCloseOutLiquidityTier(collateralAsset);
        uint256 tierBps = f.tier == 3 ? c.tier3Bps : f.tier == 2 ? c.tier2Bps : f.tier == 1 ? c.tier1Bps : 0;
        if (tierBps == 0) {
            f.reason = FloorReason.Shallow;
            return f;
        }

        (bool okC, uint256 pC) = _price1e18(collateralAsset);
        (bool okP, uint256 pP) = _price1e18(principalAsset);
        if (!okC || !okP) {
            f.reason = FloorReason.Unpriced;
            return f;
        }

        // Calm: the rate now against each of the last two hours' rates.
        uint256 hour = block.timestamp / 1 hours;
        for (uint256 back = 1; back <= 2; ++back) {
            uint256 cC = LibVaipakam.storageSlot().hourlyPrice1e18[collateralAsset][hour - back];
            uint256 cP = LibVaipakam.storageSlot().hourlyPrice1e18[principalAsset][hour - back];
            if (cC == 0 || cP == 0) {
                f.reason = FloorReason.NoCheckpoint;
                return f;
            }
            if (_moved(pC, pP, cC, cP, c.calmMoveBps)) {
                f.reason = FloorReason.Moving;
                return f;
            }
        }

        // Cushion: the collateral's value in the numeraire against the
        // debt's, both at the current oracle, read in 1e18 per whole token.
        (bool okDC, uint8 dC) = LibNumeraireValue.tryTokenDecimals(collateralAsset);
        (bool okDP, uint8 dP) = LibNumeraireValue.tryTokenDecimals(principalAsset);
        if (!okDC || !okDP) {
            f.reason = FloorReason.Unpriced;
            return f;
        }
        uint256 colValue = Math.mulDiv(collateralAmount, pC, 10 ** dC);
        uint256 debtValue = Math.mulDiv(debt, pP, 10 ** dP, Math.Rounding.Ceil);
        if (debtValue == 0 || colValue * LibVaipakam.BASIS_POINTS < debtValue * c.cushionBps) {
            f.reason = FloorReason.ThinCushion;
            return f;
        }

        f.bps = tierBps < cap ? tierBps : cap;
        f.reason = FloorReason.Tight;
    }

    // ─── Config ──────────────────────────────────────────────────────────

    /**
     * @notice Set the forced-sale floor settings. Pass 0 for any field to
     *         restore its default.
     * @dev    ADMIN_ROLE-only (the Timelock after handover). Each tier figure
     *         must lie in [{SALE_FLOOR_TIER_BPS_MIN}, the slippage cap], and
     *         the figures must not loosen as depth grows (tier 3 <= tier 2 <=
     *         tier 1). The calm bound lies in [0.5%, 10%], the cushion in
     *         [105%, 200%]. A sale already in flight is not affected; the
     *         next sale reads the new figures.
     */
    function setSaleFloorConfig(
        uint16 tier1Bps,
        uint16 tier2Bps,
        uint16 tier3Bps,
        uint16 calmMoveBps,
        uint16 cushionBps
    ) external onlyRole(LibAccessControl.ADMIN_ROLE) {
        uint256 cap = LibVaipakam.cfgMaxLiquidationSlippageBps();
        _inRange("saleFloorTier1Bps", tier1Bps, LibVaipakam.SALE_FLOOR_TIER_BPS_MIN, cap);
        _inRange("saleFloorTier2Bps", tier2Bps, LibVaipakam.SALE_FLOOR_TIER_BPS_MIN, cap);
        _inRange("saleFloorTier3Bps", tier3Bps, LibVaipakam.SALE_FLOOR_TIER_BPS_MIN, cap);
        _inRange(
            "saleFloorCalmMoveBps",
            calmMoveBps,
            LibVaipakam.SALE_FLOOR_CALM_MOVE_BPS_MIN,
            LibVaipakam.SALE_FLOOR_CALM_MOVE_BPS_MAX
        );
        _inRange(
            "saleFloorCushionBps",
            cushionBps,
            LibVaipakam.SALE_FLOOR_CUSHION_BPS_MIN,
            LibVaipakam.SALE_FLOOR_CUSHION_BPS_MAX
        );
        LibVaipakam.storageSlot().saleFloorCfg = LibVaipakam.SaleFloorConfig({
            tier1Bps: tier1Bps,
            tier2Bps: tier2Bps,
            tier3Bps: tier3Bps,
            calmMoveBps: calmMoveBps,
            cushionBps: cushionBps
        });
        LibVaipakam.SaleFloorConfig memory c = LibVaipakam.cfgSaleFloor();
        if (c.tier3Bps > c.tier2Bps || c.tier2Bps > c.tier1Bps) {
            revert IVaipakamErrors.ParameterOutOfRange(
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("saleFloorTierOrder"),
                c.tier3Bps,
                0,
                c.tier1Bps
            );
        }
        emit SaleFloorConfigSet(c.tier1Bps, c.tier2Bps, c.tier3Bps, c.calmMoveBps, c.cushionBps);
    }

    /// @notice The forced-sale floor settings in effect (defaults where unset).
    function getSaleFloorConfig() external view returns (LibVaipakam.SaleFloorConfig memory) {
        return LibVaipakam.cfgSaleFloor();
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /// @dev `asset`'s oracle price scaled to 1e18, or false when it cannot be
    ///      read (any reason the strict reader refuses) or reads zero.
    function _price1e18(address asset) private view returns (bool ok, uint256 p) {
        try OracleFacet(address(this)).getAssetPrice(asset) returns (uint256 price, uint8 dec) {
            if (price == 0) return (false, 0);
            p = dec <= 18 ? price * 10 ** (18 - dec) : price / 10 ** (dec - 18);
            ok = p != 0;
        } catch {
            return (false, 0);
        }
    }

    /// @dev Whether the collateral/principal rate moved more than `boundBps`
    ///      between the checkpoint (`cC / cP`) and now (`pC / pP`), measured
    ///      against the checkpoint rate. Cross-multiplied at full width.
    function _moved(uint256 pC, uint256 pP, uint256 cC, uint256 cP, uint256 boundBps)
        private
        pure
        returns (bool)
    {
        // now / then = (pC * cP) / (pP * cC); compare it with 1 ± bound.
        uint256 nowScaled = Math.mulDiv(pC, cP * LibVaipakam.BASIS_POINTS, pP);
        uint256 thenScaled = cC * LibVaipakam.BASIS_POINTS;
        uint256 diff = nowScaled > thenScaled ? nowScaled - thenScaled : thenScaled - nowScaled;
        return diff * LibVaipakam.BASIS_POINTS > thenScaled * boundBps;
    }

    function _inRange(bytes32 name, uint256 value, uint256 lo, uint256 hi) private pure {
        if (value != 0 && (value < lo || value > hi)) {
            revert IVaipakamErrors.ParameterOutOfRange(name, value, lo, hi);
        }
    }
}
