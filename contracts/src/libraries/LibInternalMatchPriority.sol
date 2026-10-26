// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/// @dev The one Diamond view the window rule reads, routed through the
///      Diamond's fallback (a `staticcall`, no state). Declared here rather
///      than importing `RiskFacet`, which itself uses this library.
interface ILoanLtvReader {
    function calculateLTV(uint256 loanId) external view returns (uint256);
}

/**
 * @title  LibInternalMatchPriority
 * @author Vaipakam Developer Team
 * @notice The ONE rule for the internal-match priority window (B.2 / PR4,
 *         #2734). While the internal-match switch is on, a liquidatable loan
 *         whose LTV sits in the band
 *         `[liquidationLtvBpsAtInit, liquidationLtvBpsAtInit + window)`
 *         is reserved for an internal match: no route that sells or seizes
 *         its collateral outside the protocol may run. Above the band every
 *         route opens up.
 * @dev    Every external liquidation route asks here, so the routes cannot
 *         disagree on the window's bounds, and a new route that sells or
 *         seizes collateral must call {requireOutside} too: the full liquidation (after its internal-match
 *         auto-dispatch found nothing), the partial liquidation, the split
 *         liquidation and the discounted liquidation, and the discounted
 *         liquidation's preview. Before #2734 the first three each carried
 *         their own copy and the discounted route had none.
 *
 *         The band is bounded so deferring is safe: the window is at most
 *         500 bps and the highest tier threshold
 *         (`MAX_TIER_LIQUIDATION_LTV_BPS`) is 9,500, so external routes open
 *         by 100% LTV at the latest.
 *
 *         A loan with no snapshotted threshold (`liquidationLtvBpsAtInit`
 *         zero, an illiquid loan) is never in the window. Health Factor
 *         below 1 already implies an LTV at or above the threshold for
 *         liquid collateral, so only the upper bound needs checking.
 */
library LibInternalMatchPriority {
    /// @notice The loan's LTV is still inside the internal-match priority
    ///         window `[liquidationLtvBpsAtInit, windowCeilingBps)`, so an
    ///         external liquidation route must defer to an internal match.
    ///         Above the ceiling external routes open up; below the threshold
    ///         the loan is not liquidatable at all.
    error InternalMatchOnlyBand(uint256 currentLtvBps, uint256 windowCeilingBps);

    /// @notice Whether `loan` is inside the window now, with the LTV and
    ///         ceiling the answer was read from (both zero when the switch
    ///         is off or the loan has no threshold).
    function window(uint256 loanId, LibVaipakam.Loan storage loan)
        internal
        view
        returns (bool inWindow, uint256 currentLtvBps, uint256 windowCeilingBps)
    {
        if (!LibVaipakam.cfgInternalMatchEnabled()) return (false, 0, 0);
        uint256 thresholdBps = uint256(loan.liquidationLtvBpsAtInit);
        if (thresholdBps == 0) return (false, 0, 0);
        windowCeilingBps = thresholdBps + LibVaipakam.cfgExternalLiquidationPriorityWindowBps();
        currentLtvBps = ILoanLtvReader(address(this)).calculateLTV(loanId);
        inWindow = currentLtvBps < windowCeilingBps;
    }

    /// @notice Revert {InternalMatchOnlyBand} when `loan` is inside the
    ///         window. Every external liquidation route calls this.
    function requireOutside(uint256 loanId, LibVaipakam.Loan storage loan) internal view {
        (bool inWindow, uint256 currentLtvBps, uint256 windowCeilingBps) = window(loanId, loan);
        if (inWindow) revert InternalMatchOnlyBand(currentLtvBps, windowCeilingBps);
    }
}
