// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibPriceGuard} from "./LibPriceGuard.sol";
import {OracleFacet} from "../facets/OracleFacet.sol";

/**
 * @title  LibPriceRead
 * @author Vaipakam Developer Team
 * @notice The one way a Diamond reader that can carry on without a price
 *         reads one (#3504): the hourly and daily price checkpoints, the
 *         pair-calm rule, the fee-discount and fee-entitlement valuations
 *         and the reward valuations.
 * @dev    Each of those readers catches a refused price and treats it as
 *         "no price". A read that ran out of gas would be caught the same
 *         way, so the caller's gas limit could choose the outcome, and a gas
 *         estimate would find the limit at which the price is skipped, not
 *         the one at which it is read. {tryAssetPrice} checks, before the
 *         self-call, that it holds enough for `OracleFacet.getAssetPrice` to
 *         give the price guard its whole budget ({LibPriceGuard.GUARD_READ_GAS}),
 *         and reverts {LibPriceGuard.PriceReadOutOfGas} by name when it does
 *         not. A refusal the guard returns (no feed, stale, divergent, a
 *         missing guard) still reads as "no price"; running short of gas
 *         never does.
 *
 *         The price is read through a Diamond self-call, not from the guard
 *         directly, so the guard lookup and its numeraire check stay in
 *         `OracleFacet` and out of every facet this library is inlined into.
 */
library LibPriceRead {
    /// @notice `asset`'s price from `OracleFacet.getAssetPrice`, or
    ///         `ok = false` when the Diamond refuses it for any reason
    ///         other than gas. Reverts {LibPriceGuard.PriceReadOutOfGas}
    ///         when too little gas is left to read it in full.
    function tryAssetPrice(address asset) internal view returns (bool ok, uint256 price, uint8 decimals) {
        LibPriceGuard.requireSelfReadGas();
        try OracleFacet(address(this)).getAssetPrice(asset) returns (uint256 p, uint8 d) {
            return (true, p, d);
        } catch (bytes memory reason) {
            // The facet's own check should never fire after the one above,
            // but if it does it is the same fact and is passed on by name,
            // never read as a missing price.
            if (reason.length == 4 && bytes4(reason) == LibPriceGuard.PriceReadOutOfGas.selector) {
                revert LibPriceGuard.PriceReadOutOfGas();
            }
            return (false, 0, 0);
        }
    }
}
