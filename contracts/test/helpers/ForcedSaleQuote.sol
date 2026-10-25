// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {ForcedSaleFacet} from "../../src/facets/ForcedSaleFacet.sol";

/**
 * @notice The collateral amount a keeper would quote for a forced sale now
 *         (#2796): `ForcedSaleFacet.previewForcedSale(loanId, kind).sell`,
 *         the least amount the host accepts while the plan holds.
 *
 *         Returns 0 when no sale of that kind is owed (the preview's
 *         all-zero plan) or the preview reverts (no fresh price), so a test
 *         that expects the entry point itself to refuse still reaches that
 *         refusal.
 *
 * @dev Free functions, like `AdapterCallHelpers`, so any test can import
 *      them without changing its inheritance. Read the quote into a local
 *      BEFORE `vm.prank` / `vm.expectRevert`: a view call made while
 *      evaluating the entry point's arguments would consume the cheatcode.
 */
function forcedSaleQuote(address diamond, uint256 loanId, ForcedSaleFacet.ForcedSaleKind kind)
    view
    returns (uint256)
{
    try ForcedSaleFacet(diamond).previewForcedSale(loanId, kind) returns (
        ForcedSaleFacet.ForcedSalePlan memory plan
    ) {
        return plan.sell;
    } catch {
        return 0;
    }
}

/// @notice {forcedSaleQuote} for the time-based default.
function defaultQuote(address diamond, uint256 loanId) view returns (uint256) {
    return forcedSaleQuote(diamond, loanId, ForcedSaleFacet.ForcedSaleKind.TimeBasedDefault);
}

/// @notice {forcedSaleQuote} for the Health-Factor liquidation.
function liquidationQuote(address diamond, uint256 loanId) view returns (uint256) {
    return forcedSaleQuote(diamond, loanId, ForcedSaleFacet.ForcedSaleKind.HealthFactorLiquidation);
}

/// @notice {forcedSaleQuote} for the periodic-interest settlement.
function periodicQuote(address diamond, uint256 loanId) view returns (uint256) {
    return forcedSaleQuote(diamond, loanId, ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement);
}

/// @notice The whole plan `ForcedSaleFacet.previewForcedSale` publishes now,
///         for a test that derives expected figures from the debt the sale
///         settles (`plan.debt`) or the amount it sells (`plan.sell`). Same
///         read-before-cheatcode caution as {forcedSaleQuote}.
function forcedSalePlan(address diamond, uint256 loanId, ForcedSaleFacet.ForcedSaleKind kind)
    view
    returns (ForcedSaleFacet.ForcedSalePlan memory)
{
    return ForcedSaleFacet(diamond).previewForcedSale(loanId, kind);
}
