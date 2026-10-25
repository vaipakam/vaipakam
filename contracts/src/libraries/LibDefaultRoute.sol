// src/libraries/LibDefaultRoute.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibFallback} from "./LibFallback.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";
import {RiskFacet} from "../facets/RiskFacet.sol";

/**
 * @title  LibDefaultRoute
 * @author Vaipakam Developer Team
 * @notice #2796 — the ONE rule for which route a time-based default of an
 *         ERC-20 loan takes. `DefaultedFacet.triggerDefault` acts on it and
 *         `ForcedSaleFacet.previewForcedSale` reads it, so the published sale
 *         plan exists exactly when the default would sell: a caller is never
 *         asked to price a sale the default will not run, and a loan whose
 *         default takes no sale is not left without a quote it cannot get.
 *
 *         The rule (README §1, #1192, #2419, #666):
 *          - A loan liquid on both legs at origination is the only kind a sale
 *            applies to. Its PAIR is probed first: when either leg has no
 *            usable price the default enters the fallback unpriced
 *            ({Route.UnpricedFallback}), whatever the other leg says. A
 *            DISTRUSTED price reverts inside the probe instead.
 *          - A priced pair whose collateral the live market check still finds
 *            liquid sells ({Route.Sale}), unless its value collapsed (LTV
 *            above the volatility threshold), which moves the whole
 *            collateral in kind ({Route.InKind}).
 *          - A loan that began illiquid on either leg, or whose collateral the
 *            live check finds illiquid, moves in kind when both parties
 *            consented to that ({Route.InKind}), and is refused otherwise
 *            ({Route.Refused}).
 *
 * @dev    `internal` view functions; they inline into each caller and their
 *         reads are self-calls through the Diamond (`address(this)`).
 */
library LibDefaultRoute {
    /// @notice The route a time-based default of an ERC-20 loan takes now.
    enum Route {
        Sale,
        UnpricedFallback,
        InKind,
        Refused
    }

    /// @notice {Route} for `loan`, an ERC-20 loan (`assetType == ERC20`).
    function erc20Route(LibVaipakam.Loan storage loan) internal view returns (Route) {
        bool liquidLoan =
            loan.collateralLiquidity == LibVaipakam.LiquidityStatus.Liquid &&
            loan.principalLiquidity == LibVaipakam.LiquidityStatus.Liquid;
        if (liquidLoan) {
            (bool pairPriced, ) = LibFallback.tryOracleRate(
                address(this), loan.collateralAsset, loan.principalAsset
            );
            if (!pairPriced) return Route.UnpricedFallback;
            // The live market check is read only where it can change the
            // route: a loan liquid at origination whose pair is priced. It
            // refuses a distrusted collateral price (#666).
            if (
                OracleFacet(address(this)).checkLiquidityOnActiveNetwork(loan.collateralAsset) ==
                LibVaipakam.LiquidityStatus.Liquid
            ) {
                return RiskFacet(address(this)).calculateLTV(loan.id) >
                    LibVaipakam.cfgVolatilityLtvThresholdBps()
                    ? Route.InKind
                    : Route.Sale;
            }
        }
        return loan.riskAndTermsConsentFromBoth ? Route.InKind : Route.Refused;
    }
}
