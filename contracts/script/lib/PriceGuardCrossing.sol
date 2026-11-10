// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IDiamondLoupe} from "@diamond-3/interfaces/IDiamondLoupe.sol";
import {OracleAdminFacet} from "../../src/facets/OracleAdminFacet.sol";

/**
 * @title  PriceGuardCrossing
 * @notice The one refusal every in-place refresh takes against a Diamond from
 *         before the price guard (#3272 part 2). Such a Diamond prices from
 *         config in its own storage and has recorded no protocol registry, so
 *         a refreshed oracle would refuse every price while the old config
 *         sits unread. The crossing is a fresh deploy.
 */
library PriceGuardCrossing {
    /// @notice The target Diamond predates the price guard. Fresh deploy only.
    error PredatesPriceGuard(address diamond);

    /// @notice Refuse a Diamond that does not route
    ///         `OracleAdminFacet.getProtocolRegistry`, or routes it with no
    ///         registry recorded. Call it before anything is deployed, so a
    ///         refused run sends nothing.
    function requireRecorded(address diamond) internal view {
        if (
            IDiamondLoupe(diamond).facetAddress(OracleAdminFacet.getProtocolRegistry.selector) == address(0)
                || OracleAdminFacet(diamond).getProtocolRegistry() == address(0)
        ) revert PredatesPriceGuard(diamond);
    }
}
