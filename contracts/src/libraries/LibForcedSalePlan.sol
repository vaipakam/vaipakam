// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFallback} from "./LibFallback.sol";
import {LibSaleSizing} from "./LibSaleSizing.sol";
import {LibEntitlement} from "./LibEntitlement.sol";
import {LibPeriodicInterest} from "./LibPeriodicInterest.sol";
import {LibLoanClock} from "./LibLoanClock.sol";
import {LibDefaultRoute} from "./LibDefaultRoute.sol";
import {ForcedSaleFacet} from "../facets/ForcedSaleFacet.sol";
import {RiskFacet} from "../facets/RiskFacet.sol";
import {SaleFloorFacet} from "../facets/SaleFloorFacet.sol";

/**
 * @title  LibForcedSalePlan
 * @author Vaipakam Developer Team
 * @notice The ONE sizing rule of a forced sale (#2795 / #2796): whether a
 *         sale of a kind is due, the debt it settles, and the plan (need,
 *         collateral to sell, floor, largest accepted quote). The sale itself
 *         (`ForcedSaleFacet.sellToNeed`, which checks the caller's quote
 *         against it) and its preview (`ForcedSalePreviewFacet`) both size
 *         through this library, so the figure a keeper is shown and the
 *         figure the sale enforces cannot drift.
 * @dev    Split out with the preview facet (#3205 part 2) because
 *         ForcedSaleFacet had reached 11 bytes under EIP-170. The types stay on
 *         ForcedSaleFacet, where every caller already names them.
 */
library LibForcedSalePlan {
    /// @dev The quote margin a covered sale accepts above `sell`. The ONE
    ///      definition: `ForcedSaleFacet.QUOTE_MARGIN_BPS` publishes it.
    uint256 internal constant QUOTE_MARGIN_BPS = 200;


    /// @dev Whether a sale of `kind` is due on `loan` now (the preview's
    ///      gate; each caller enforces its own, stricter set).
    function isDue(LibVaipakam.Loan storage loan, ForcedSaleFacet.ForcedSaleKind kind) internal view returns (bool) {
        if (loan.status != LibVaipakam.LoanStatus.Active) return false;
        if (kind == ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault) {
            // A default sells only on its sale route (#2796): the plan exists
            // exactly when `triggerDefault` would sell, by the one rule both
            // read. The unpriced fallback, the in-kind move and a refused
            // default sell nothing, so they need no quote and no price here.
            return block.timestamp >
                LibLoanClock.maturity(loan) + LibVaipakam.gracePeriod(loan.durationDays) &&
                loan.assetType == LibVaipakam.AssetType.ERC20 &&
                LibDefaultRoute.erc20Route(loan) == LibDefaultRoute.Route.Sale;
        }
        if (kind == ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement) return true;
        return RiskFacet(address(this)).calculateHealthFactor(loan.id) < LibVaipakam.HF_SCALE;
    }

    /// @dev `D` for `kind`. Periodic: the period's shortfall when its
    ///      settlement is allowed, else 0. Terminal: the borrow balance net of
    ///      interest already settled, plus the late fee — the figure every
    ///      forced close-out of the whole loan settles.
    function debtFor(LibVaipakam.Loan storage loan, ForcedSaleFacet.ForcedSaleKind kind) internal view returns (uint256) {
        if (kind == ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement) {
            return LibPeriodicInterest.settleableShortfall(loan);
        }
        if (loan.status != LibVaipakam.LoanStatus.Active) return 0;
        return LibEntitlement.currentBorrowBalance(loan) + LibVaipakam.calculateLateFee(loan.id);
    }

    /// @dev The plan for selling `loan`'s collateral to cover `debt`, and the
    ///      oracle rate it was sized at.
    function planFor(LibVaipakam.Loan storage loan, uint256 debt)
        internal
        view
        returns (ForcedSaleFacet.ForcedSalePlan memory plan, LibFallback.Rate memory rate)
    {
        uint256 pledged = loan.collateralAmount;
        // #3359 — the one floor rule, read by self-call so it exists once.
        // Its cushion is measured against the whole loan's debt, never only
        // what this sale covers: a periodic sale covers one period's
        // shortfall, which says nothing about how well the loan is cushioned.
        // A terminal sale's `debt` already is the whole balance plus the late
        // fee, so the larger of the two serves every kind.
        uint256 cap = SaleFloorFacet(address(this))
            .saleFloorBps(
                loan.collateralAsset,
                loan.principalAsset,
                pledged,
                Math.max(debt, LibEntitlement.currentBorrowBalance(loan))
            ).bps;
        plan.floorBps = cap;
        plan.debt = debt;
        plan.need = debt
            + Math.mulDiv(debt, LibVaipakam.cfgLiquidationHandlingFeeBps(), LibVaipakam.BASIS_POINTS, Math.Rounding.Ceil)
            + Math.mulDiv(debt, maxBonusBps(loan.collateralAsset), LibVaipakam.BASIS_POINTS, Math.Rounding.Ceil);
        rate = LibFallback.oracleRate(address(this), loan.collateralAsset, loan.principalAsset);
        (plan.covered, plan.sell, plan.floor) =
            LibSaleSizing.sizeSaleAtRate(rate, plan.need, pledged, cap);
        if (plan.covered) {
            plan.maxSell = plan.sell + (plan.sell * QUOTE_MARGIN_BPS) / LibVaipakam.BASIS_POINTS;
            if (plan.maxSell > pledged) plan.maxSell = pledged;
        } else {
            plan.sell = pledged;
            plan.floor = LibSaleSizing.floorAtRate(rate, pledged, cap);
            plan.maxSell = pledged;
        }
    }

    /// @dev `bMax`: the protocol's largest keeper bonus, lowered by the
    ///      collateral's own ceiling when one is set — the same two caps
    ///      {LibEntitlement.liquidatorIncentiveBps} applies to the bonus paid.
    function maxBonusBps(address collateralAsset) internal view returns (uint256 bps) {
        bps = LibVaipakam.cfgMaxLiquidatorIncentiveBps();
        uint256 assetCap = LibVaipakam.storageSlot().assetRiskParams[collateralAsset].liqBonusBps;
        if (assetCap != 0 && bps > assetCap) bps = assetCap;
    }
}
