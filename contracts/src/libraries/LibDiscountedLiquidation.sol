// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LibVaipakam} from "./LibVaipakam.sol";
import {LibEntitlement} from "./LibEntitlement.sol";
import {LibFallback} from "./LibFallback.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/**
 * @title  LibDiscountedLiquidation
 * @notice The ONE rule for the figures of a discounted liquidation
 *         ({RiskFacet.triggerLiquidationDiscounted}): what the liquidator
 *         pays, and how much collateral it receives for it (#2697).
 * @dev    Two readers, one rule. The liquidation itself charges and seizes
 *         through here, and so does its preview
 *         ({RiskPreviewFacet.previewDiscountedLiquidation}), so the preview
 *         read in the same block as the liquidation names exactly what the
 *         liquidation then does. A caller that funds the debt up front (a
 *         flash-loan receiver) reads the preview and borrows that figure;
 *         before #2697 it could only guess it.
 *
 *         THE RULE, with `D` the debt and `d` the collateral's per-tier
 *         discount:
 *         - `D` = the borrow balance (principal plus accrued interest, net of
 *           interest already settled) plus the late fee — the figure every
 *           forced close-out of the whole loan settles;
 *         - the seizure is the collateral worth `D` at the oracle, rounded
 *           down, times `1 + d`, and never more than the pledged collateral;
 *         - the rest of the collateral is the borrower's surplus.
 *         `D` grows every second the loan stays open, so a preview read
 *         before the block that settles names a figure the liquidation will
 *         meet or exceed, never the figure itself.
 */
library LibDiscountedLiquidation {
    /// @notice Why a discounted liquidation of a loan can or cannot run now,
    ///         in the order the liquidation checks them. Values are
    ///         append-only. {Ready} is not the zero value, so an unset
    ///         reading never says the liquidation can run.
    enum Status {
        Paused, // the protocol is paused (manually or by an auto-pause window)
        Disabled, // the protocol's discount-path switch is off
        NotActive, // the loan is not Active
        SequencerUnhealthy, // the L2 sequencer circuit breaker is tripped
        Healthy, // Health Factor at or above 1
        Untiered, // the collateral has no liquidity tier, so no discount
        Unpriced, // an oracle leg is unavailable, so no seizure can be sized
        Ready // every check above passed; the figures are the liquidation's
    }

    /// @notice A discounted liquidation of one loan, as it would run now.
    /// @param status          See {Status}. The figures below are meaningful
    ///                        only when it is {Status.Ready}; otherwise those
    ///                        not yet known are zero.
    /// @param principalAsset  What the liquidator pays the debt in.
    /// @param collateralAsset What the liquidator receives.
    /// @param tier            The collateral's effective liquidity tier.
    /// @param discountBps     The tier's discount.
    /// @param debt            `D`, pulled from the liquidator in full.
    /// @param seized          Collateral delivered to the liquidator's
    ///                        recipient.
    /// @param surplus         Collateral left in the borrower's vault for
    ///                        the borrower's claim.
    struct Preview {
        Status status;
        address principalAsset;
        address collateralAsset;
        uint8 tier;
        uint16 discountBps;
        uint256 debt;
        uint256 seized;
        uint256 surplus;
    }

    /// @notice The collateral's effective liquidity tier and that tier's
    ///         discount. Tier 0 (unclassified) carries no discount, and the
    ///         liquidation refuses it.
    function discountFor(address collateralAsset) internal view returns (uint8 tier, uint16 discountBps) {
        tier = OracleFacet(address(this)).getEffectiveLiquidityTier(collateralAsset);
        discountBps = LibVaipakam.effectiveTierLiqDiscountBps(tier);
    }

    /// @notice `D` for `loan` now.
    function debt(LibVaipakam.Loan storage loan) internal view returns (uint256) {
        return LibEntitlement.currentBorrowBalance(loan) + LibVaipakam.calculateLateFee(loan.id);
    }

    /// @notice The collateral a liquidator paying `totalDebt` receives at
    ///         `discountBps`, capped at the pledged collateral. `priced` is
    ///         false when either oracle leg is unavailable; a distrusted price
    ///         reverts with its read's own divergence error (#666). Rounded
    ///         down: the liquidator has paid the lender in full, so the
    ///         rounding unit stays with the borrower's surplus.
    function seizure(LibVaipakam.Loan storage loan, uint256 totalDebt, uint16 discountBps)
        internal
        view
        returns (bool priced, uint256 seized)
    {
        uint256 collForDebt;
        (priced, collForDebt) = LibFallback.collateralEquivalent(
            address(this), totalDebt, loan.collateralAsset, loan.principalAsset, Math.Rounding.Floor
        );
        if (!priced) return (false, 0);
        seized = (collForDebt * (LibVaipakam.BASIS_POINTS + discountBps)) / LibVaipakam.BASIS_POINTS;
        // An underwater loan gives up all its collateral. The liquidator's
        // profit or loss is settled at its own sale price; the protocol's
        // books are whole once `totalDebt` lands at the lender and treasury.
        if (seized > loan.collateralAmount) seized = loan.collateralAmount;
    }
}
