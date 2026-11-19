// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibAccessControl, DiamondAccessControl} from "../libraries/LibAccessControl.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {NumeraireValueFacet} from "./NumeraireValueFacet.sol";

/**
 * @title CollateralConcentrationFacet
 * @author Vaipakam Developer Team
 * @notice #3685 — how much of one collateral asset is pledged across the
 *         whole platform, and the graded response to it.
 *
 *         Each loan is judged alone when it opens: its collateral must be
 *         liquid and its size fits the depth its liquidity tier measured.
 *         Nothing looked at the total. When a great deal of one asset is
 *         pledged and its price falls, many loans need a sale into the same
 *         market at once. This facet measures that:
 *
 *           ratio = value of the asset pledged under open loans
 *                   / the sale size its effective liquidity tier is measured at
 *
 *         and answers with three steps that apply to NEW loans only, judged
 *         when a loan opens, and never refuse one:
 *           - at or above Caution (default 5x): the app warns, and the loan
 *             is recorded as not eligible for the shortfall reserve;
 *           - at or above High (default 10x): the loan-opening LTV cap is the
 *             next lower tier's cap; for the lowest liquid tier, that tier's
 *             cap less a governed step.
 *         An open loan is never changed by a later rise in the ratio.
 *
 * @dev    The ONE host of the concentration rule. Every loan-opening path
 *         and every preview reads its LTV cap through {newLoanInitLtvCapBps}
 *         (LoanFacet's admission gate and stamp, OfferPreviewFacet's match
 *         bounds, the offer-create bounds in LibRiskMath, the offer book's
 *         logical amount ceiling), so a fill that the lowered cap refuses is
 *         refused by the existing check with the existing reason, and the
 *         previews agree with execution. The pledged total is written only by
 *         LibEncumbrance, beside every collateral lien change. Settings are
 *         ADMIN_ROLE (the Timelock after handover), bounded. Design:
 *         `CollateralConcentrationDesign.md`.
 */
contract CollateralConcentrationFacet is DiamondAccessControl {
    /// @notice One collateral asset's concentration, as a loan opening now
    ///         would see it.
    /// @param pledged      The amount pledged under live collateral liens, in
    ///                     the asset's own units.
    /// @param pledgedValue Its value at the oracle, 1e18 numeraire (0 when
    ///                     unpriced).
    /// @param tier         The asset's effective liquidity tier.
    /// @param depthRef     The sale size that tier is measured at, 1e18
    ///                     numeraire.
    /// @param ratioX100    `pledgedValue / depthRef`, in hundredths.
    /// @param cautionX100  The Caution threshold in force for the asset.
    /// @param highX100     The High threshold in force for the asset.
    /// @param level        `CONCENTRATION_NORMAL` / `_CAUTION` / `_HIGH`.
    /// @param priced       False when the asset's price could not be read: the
    ///                     value, ratio and level are then unknown and read 0,
    ///                     and a loan opening would fail its own price read.
    /// @param regimeCapBps The most a new loan may borrow under the current
    ///                     regime before concentration: the tiered cap, or,
    ///                     untiered, the lower of the asset's ceiling and the
    ///                     LTV the HF admission floor allows.
    /// @param loweredCapBps The lowered tier cap the High level holds a new
    ///                     loan to (0 for a tier-0 asset, which is not
    ///                     lowered).
    /// @param capBps       The cap a loan opening now is held to.
    /// @param loweredCapBinds True when the level is High AND the lowered cap
    ///                     is below the regime cap, so it actually lowers what
    ///                     a new loan may borrow. At High with this false (for
    ///                     example a tier-3 asset in the untiered regime, whose
    ///                     next tier's cap is above what the HF floor already
    ///                     allows), the level changes no cap and nothing may
    ///                     say it does.
    struct Concentration {
        uint256 pledged;
        uint256 pledgedValue;
        uint8 tier;
        uint256 depthRef;
        uint256 ratioX100;
        uint16 cautionX100;
        uint16 highX100;
        uint8 level;
        bool priced;
        uint256 regimeCapBps;
        uint256 loweredCapBps;
        uint256 capBps;
        bool loweredCapBinds;
    }

    /// @notice The platform thresholds changed.
    /// @custom:event-category informational/config
    event ConcentrationConfigSet(uint16 cautionX100, uint16 highX100, uint16 lowestTierStepBps);

    /// @notice An asset's own (tighter) thresholds changed; zero = the
    ///         platform value.
    /// @custom:event-category informational/config
    event AssetConcentrationConfigSet(address indexed asset, uint16 cautionX100, uint16 highX100);

    /// @notice Set the platform thresholds. Zero keeps a field's default.
    /// @dev    Bounds: Caution 2x..20x, High above Caution up to 50x, the
    ///         lowest-tier step 5..25 percentage points.
    function setConcentrationConfig(uint16 cautionX100, uint16 highX100, uint16 lowestTierStepBps)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        s.concentrationCfg = LibVaipakam.ConcentrationConfig(cautionX100, highX100, lowestTierStepBps);
        (uint16 c, uint16 h, uint16 step) = _platform();
        _inRange("concentrationCaution", c, LibVaipakam.CONCENTRATION_CAUTION_X100_MIN, LibVaipakam.CONCENTRATION_CAUTION_X100_MAX);
        _inRange("concentrationHigh", h, uint256(c) + 1, LibVaipakam.CONCENTRATION_HIGH_X100_MAX);
        _inRange("concentrationStep", step, LibVaipakam.CONCENTRATION_STEP_BPS_MIN, LibVaipakam.CONCENTRATION_STEP_BPS_MAX);
        emit ConcentrationConfigSet(c, h, step);
    }

    /// @notice Give `asset` tighter thresholds than the platform's. Zero
    ///         clears a field back to the platform value.
    /// @dev    Each set field must sit within the platform bounds and at or
    ///         below the platform value now, and High above Caution. A later
    ///         platform change never loosens it: the lower of the two applies.
    function setAssetConcentrationConfig(address asset, uint16 cautionX100, uint16 highX100)
        external
        onlyRole(LibAccessControl.ADMIN_ROLE)
    {
        if (asset == address(0)) revert IVaipakamErrors.InvalidAddress();
        (uint16 pc, uint16 ph,) = _platform();
        if (cautionX100 != 0) {
            _inRange("assetConcentrationCaution", cautionX100, LibVaipakam.CONCENTRATION_CAUTION_X100_MIN, pc);
        }
        if (highX100 != 0) {
            _inRange("assetConcentrationHigh", highX100, LibVaipakam.CONCENTRATION_CAUTION_X100_MIN + 1, ph);
        }
        LibVaipakam.storageSlot().concentrationAssetCfg[asset] =
            LibVaipakam.ConcentrationConfig(cautionX100, highX100, 0);
        (uint16 c, uint16 h) = _thresholds(asset);
        if (h <= c) {
            revert IVaipakamErrors.ParameterOutOfRange(bytes32("assetConcentrationOrder"), h, uint256(c) + 1, ph);
        }
        emit AssetConcentrationConfigSet(asset, cautionX100, highX100);
    }

    /// @notice The platform thresholds in force (defaults where unset).
    function getConcentrationConfig()
        external
        view
        returns (uint16 cautionX100, uint16 highX100, uint16 lowestTierStepBps)
    {
        return _platform();
    }

    /// @notice The thresholds in force for `asset` (its own where tighter).
    function getAssetConcentrationThresholds(address asset)
        external
        view
        returns (uint16 cautionX100, uint16 highX100)
    {
        return _thresholds(asset);
    }

    /// @notice `asset`'s concentration now: the pledged amount and value, the
    ///         depth reference, the ratio, the level that applies, and the
    ///         loan-opening cap with whether the level lowers it.
    /// @dev    Never reverts on a missing price; it says the value is
    ///         unknown instead (`priced == false`).
    function getConcentration(address asset) external view returns (Concentration memory c) {
        return _concentration(asset, false);
    }

    /// @notice The LTV cap a loan opening now against `collateralAsset` is
    ///         held to, with the collateral's effective tier and its
    ///         concentration level.
    /// @dev    The ONE loan-opening cap rule. Depth-tiered regime: min(the
    ///         asset's own ceiling, its tier's cap). Untiered regime: the
    ///         asset's own ceiling (the HF floor binds beside it). At the High
    ///         level, either regime is further held to the lowered tier cap:
    ///         tier N-1's cap for tiers 2-3, tier 1's cap less the step for
    ///         tier 1 (a tier-0 collateral caps at 0 in the tiered regime and
    ///         is not lowered further). Reverts when the price cannot be read,
    ///         as the admission gate's own price read does.
    function newLoanInitLtvCapBps(address collateralAsset)
        external
        view
        returns (uint256 capBps, uint8 tier, uint8 level, bool loweredCapBinds)
    {
        Concentration memory c = _concentration(collateralAsset, true);
        return (c.capBps, c.tier, c.level, c.loweredCapBinds);
    }

    /// @notice The concentration level `loanId`'s collateral had when the
    ///         loan opened (`CONCENTRATION_NORMAL` / `_CAUTION` / `_HIGH`).
    ///         Caution or High makes the loan ineligible for the shortfall
    ///         reserve. Never changes after opening.
    function loanConcentrationAtInit(uint256 loanId) external view returns (uint8) {
        return LibVaipakam.storageSlot().loanConcentrationAtInit[loanId];
    }

    // ─── Internals ───────────────────────────────────────────────────────

    /// @dev The High-level cap: one tier lower, or the lowest tier less the
    ///      step.
    function _loweredTierCapBps(uint8 tier) private view returns (uint256) {
        if (tier >= 2) return LibVaipakam.effectiveTierMaxInitLtvBps(tier - 1);
        (,, uint16 step) = _platform();
        uint256 lowest = LibVaipakam.effectiveTierMaxInitLtvBps(1);
        return lowest > step ? lowest - step : 0;
    }

    /// @dev `strictPrice`: revert on an unreadable price (the loan-opening
    ///      path) rather than report it unknown (the view).
    function _concentration(address asset, bool strictPrice) private view returns (Concentration memory c) {
        c.pledged = LibVaipakam.storageSlot().collateralPledged[asset];
        c.tier = asset == address(0) ? 0 : OracleFacet(address(this)).getEffectiveLiquidityTier(asset);
        // The tier's probe size, numeraire with 6 decimals -> 1e18.
        c.depthRef = LibVaipakam.cfgTierSizePad(c.tier) * 1e12;
        (c.cautionX100, c.highX100) = _thresholds(asset);
        c.capBps = LibVaipakam.assetInitLtvCeilingBps(asset);
        if (LibVaipakam.cfgDepthTieredLtvEnabled()) {
            c.capBps = Math.min(c.capBps, LibVaipakam.effectiveTierMaxInitLtvBps(c.tier));
            c.regimeCapBps = c.capBps;
        } else {
            // The untiered regime enforces the asset's own ceiling and the HF
            // floor; the LTV that floor allows is the tier's liquidation LTV
            // over the floor. Reported, so a lowered cap above it is known
            // not to bind; never enforced here (the HF gate enforces it).
            c.regimeCapBps = Math.min(
                c.capBps,
                Math.mulDiv(
                    LibVaipakam.cfgTierLiquidationLtvBps(c.tier),
                    LibVaipakam.HF_SCALE,
                    LibVaipakam.minHealthFactor()
                )
            );
        }
        if (c.tier != 0) c.loweredCapBps = _loweredTierCapBps(c.tier);
        if (c.pledged == 0) {
            c.priced = true;
            return c;
        }
        if (strictPrice) {
            c.pledgedValue = NumeraireValueFacet(address(this)).getNumeraireValue(asset, c.pledged, false);
            c.priced = true;
        } else {
            try NumeraireValueFacet(address(this)).getNumeraireValue(asset, c.pledged, false) returns (uint256 v) {
                c.pledgedValue = v;
                c.priced = true;
            } catch {
                return c;
            }
        }
        c.ratioX100 = Math.mulDiv(c.pledgedValue, 100, c.depthRef);
        if (c.ratioX100 >= c.highX100) c.level = LibVaipakam.CONCENTRATION_HIGH;
        else if (c.ratioX100 >= c.cautionX100) c.level = LibVaipakam.CONCENTRATION_CAUTION;
        if (c.level == LibVaipakam.CONCENTRATION_HIGH && c.tier != 0 && c.loweredCapBps < c.regimeCapBps) {
            c.capBps = c.loweredCapBps;
            c.loweredCapBinds = true;
        }
    }

    function _platform() private view returns (uint16 c, uint16 h, uint16 step) {
        LibVaipakam.ConcentrationConfig storage p = LibVaipakam.storageSlot().concentrationCfg;
        c = p.cautionMultipleX100 == 0 ? LibVaipakam.CONCENTRATION_CAUTION_X100_DEFAULT : p.cautionMultipleX100;
        h = p.highMultipleX100 == 0 ? LibVaipakam.CONCENTRATION_HIGH_X100_DEFAULT : p.highMultipleX100;
        step = p.lowestTierStepBps == 0 ? LibVaipakam.CONCENTRATION_STEP_BPS_DEFAULT : p.lowestTierStepBps;
    }

    /// @dev The lower of the asset's own and the platform's thresholds.
    function _thresholds(address asset) private view returns (uint16 c, uint16 h) {
        (c, h,) = _platform();
        LibVaipakam.ConcentrationConfig storage a = LibVaipakam.storageSlot().concentrationAssetCfg[asset];
        if (a.cautionMultipleX100 != 0 && a.cautionMultipleX100 < c) c = a.cautionMultipleX100;
        if (a.highMultipleX100 != 0 && a.highMultipleX100 < h) h = a.highMultipleX100;
    }

    function _inRange(bytes32 name, uint256 v, uint256 lo, uint256 hi) private pure {
        if (v < lo || v > hi) revert IVaipakamErrors.ParameterOutOfRange(name, v, lo, hi);
    }
}
