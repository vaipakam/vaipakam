// src/libraries/LibCadenceAdmission.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibNumeraireValueRead} from "./LibNumeraireValueRead.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/**
 * @title LibCadenceAdmission
 * @author Vaipakam Developer Team
 * @notice #3009 — the ONE rule that decides whether a periodic-interest cadence
 *         may be originated on given offer terms (T-034, design doc §3). Offer
 *         creation, the amount re-check on offer mutation and the cadence
 *         preview all read it, so the three can never disagree about which
 *         cadence an offer may carry.
 * @dev The rule, in the order its refusals are raised
 *      (`docs/FunctionalSpecs/ProjectDetailsREADME.md`, "Periodic Interest
 *      Payments"):
 *      1. Kill-switch: with periodic interest switched off, any cadence other
 *         than `None` is refused (`PeriodicInterestDisabled`).
 *      2. Filter 0: periodic interest needs BOTH legs liquid and ERC-20; any
 *         other offer may only carry `None` (`CadenceNotAllowedForIlliquid`).
 *      3. The mandatory `Annual` floor on a loan longer than 365 days applies
 *         ONLY while the feature is on and both legs are liquid ERC-20. With
 *         the feature off, or a leg illiquid, `None` is admitted on any
 *         duration: there is no cadence such a loan could carry instead.
 *      4. Filter 2, the principal-threshold matrix: below the threshold a
 *         loan of a year or less may only carry `None`, and a multi-year one
 *         only `Annual`; at or above it any cadence is open, except `None` on
 *         a multi-year loan.
 *      5. Filter 1: a cadence's interval must be strictly shorter than the
 *         loan.
 *      Steps 4 and 5 raise `CadenceNotAllowed`.
 *
 *      The principal is valued by the shared numeraire rule (#2419), best
 *      effort: an unvalued principal reads as 0, below the threshold, which
 *      admits nothing finer than the terminal path. It is read only when step
 *      4 needs it, so a `None` offer that no floor binds costs no oracle read.
 */
library LibCadenceAdmission {
    /// @notice The terms the rule reads.
    /// @param lendingAsset        The principal asset.
    /// @param amount              The principal the rule values: the offer's
    ///                            `amount` (= `amountMin` under a range), the
    ///                            strict lower bound of what will be funded.
    /// @param durationDays        The loan duration in days.
    /// @param cadence             The cadence asked for.
    /// @param assetType           The lending asset's type.
    /// @param collateralAssetType The collateral asset's type.
    /// @param principalLiquidity  The lending asset's liquidity class.
    /// @param collateralLiquidity The collateral asset's liquidity class.
    struct Terms {
        address lendingAsset;
        uint256 amount;
        uint256 durationDays;
        LibVaipakam.PeriodicInterestCadence cadence;
        LibVaipakam.AssetType assetType;
        LibVaipakam.AssetType collateralAssetType;
        LibVaipakam.LiquidityStatus principalLiquidity;
        LibVaipakam.LiquidityStatus collateralLiquidity;
    }

    /// @notice The liquidity classes offer creation records for an offer's two
    ///         legs. A rental (`assetType` not ERC-20) carries no collateral
    ///         leg, so it records the collateral as Illiquid without pricing
    ///         anything (#2949).
    function legLiquidity(
        address lendingAsset,
        LibVaipakam.AssetType assetType,
        address collateralAsset
    )
        internal
        view
        returns (LibVaipakam.LiquidityStatus principalLiq, LibVaipakam.LiquidityStatus collateralLiq)
    {
        principalLiq = OracleFacet(address(this)).checkLiquidity(lendingAsset);
        collateralLiq = assetType == LibVaipakam.AssetType.ERC20
            ? OracleFacet(address(this)).checkLiquidity(collateralAsset)
            : LibVaipakam.LiquidityStatus.Illiquid;
    }

    /// @notice Whether both legs qualify for periodic interest: liquid AND
    ///         ERC-20 (Filter 0).
    function bothLiquid(Terms memory t) internal pure returns (bool) {
        return t.principalLiquidity == LibVaipakam.LiquidityStatus.Liquid
            && t.collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid
            && t.assetType == LibVaipakam.AssetType.ERC20
            && t.collateralAssetType == LibVaipakam.AssetType.ERC20;
    }

    /// @notice Whether the mandatory `Annual` floor binds these terms: a loan
    ///         longer than 365 days, with the feature on and both legs liquid.
    function annualFloorApplies(Terms memory t) internal view returns (bool) {
        return t.durationDays > 365
            && LibVaipakam.storageSlot().protocolCfg.periodicInterestEnabled
            && bothLiquid(t);
    }

    /// @notice The finer-cadence principal threshold in effect (numeraire
    ///         units, 1e18-scaled): the configured value, or the default while
    ///         it is unset.
    function threshold() internal view returns (uint256) {
        uint256 configured = LibVaipakam.storageSlot().protocolCfg.minPrincipalForFinerCadence;
        return configured == 0 ? LibVaipakam.PERIODIC_MIN_PRINCIPAL_FOR_FINER_CADENCE_DEFAULT : configured;
    }

    /// @notice Reverts with the refusal the rule raises for `t`; returns when
    ///         the cadence is admitted.
    function enforce(Terms memory t) internal view {
        bool isNone = t.cadence == LibVaipakam.PeriodicInterestCadence.None;

        // 1. Kill-switch, ahead of every other refusal so the disabled state
        //    is the loudest signal.
        if (!isNone && !LibVaipakam.storageSlot().protocolCfg.periodicInterestEnabled) {
            revert IVaipakamErrors.PeriodicInterestDisabled();
        }

        // 2. Filter 0.
        if (!isNone && !bothLiquid(t)) {
            revert IVaipakamErrors.CadenceNotAllowedForIlliquid(
                uint8(t.principalLiquidity), uint8(t.collateralLiquidity), uint8(t.cadence)
            );
        }

        // 3. `None` is admitted unless the multi-year floor binds. Past this
        //    point either the cadence is finer than `None` (so the feature is
        //    on and both legs are liquid) or the floor binds (same two facts).
        bool isMultiYear = t.durationDays > 365;
        if (isNone && !annualFloorApplies(t)) return;

        uint256 floor = threshold();
        uint256 principalNumeraire = LibNumeraireValueRead.valueOrZero(t.lendingAsset, t.amount);
        bool aboveThreshold = principalNumeraire >= floor;

        // 4. Filter 2.
        bool refused = isMultiYear
            ? isNone || (!aboveThreshold && t.cadence != LibVaipakam.PeriodicInterestCadence.Annual)
            : !isNone && !aboveThreshold;

        // 5. Filter 1. `None` has no interval.
        if (!refused && !isNone) {
            refused = LibVaipakam.intervalDays(t.cadence) >= t.durationDays;
        }

        if (refused) {
            revert IVaipakamErrors.CadenceNotAllowed(
                uint8(t.cadence), t.durationDays, principalNumeraire, floor
            );
        }
    }
}
