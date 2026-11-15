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
 *         {trySelfRead} applies the same rule to a best-effort self-call
 *         that reaches a price on its way to an answer (a health factor, an
 *         LTV, a liquidity class or tier, a sale admission).
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
            passOnOutOfGas(reason);
            return (false, 0, 0);
        }
    }

    /// @notice A Diamond self-call (static) to a facet function that reads a
    ///         price on its way to an answer (`RiskFacet.calculateHealthFactor`,
    ///         `calculateLTV`, `OracleFacet.checkLiquidity`,
    ///         `getEffectiveLiquidityTier`, `RiskPreviewFacet.saleAdmission`),
    ///         for a caller that carries on when the call fails: an event
    ///         figure left at zero, a conservative tier, a refused sale.
    ///         `ok = false` with the revert data when the call refused for a
    ///         reason other than gas. Reverts {LibPriceGuard.PriceReadOutOfGas}
    ///         when too little gas is held to make the call, or when the call
    ///         itself ran short.
    /// @dev    Without this, a failed call that ran out of gas reads the same
    ///         as one that was refused, so a gas estimate finds the limit at
    ///         which the read is skipped (the call is best-effort, so the
    ///         transaction still succeeds) and the caller's gas limit picks
    ///         the outcome: a health factor reported as zero, a loan stamped
    ///         at the most conservative tier, a fallback cure missed (#3504).
    ///         The check before the call covers the first read; every later
    ///         read inside the call makes its own check and reverts by name,
    ///         which is passed on here.
    /// @param  data The ABI-encoded call.
    /// @return ok   Whether the call returned.
    /// @return ret  What it returned, or its revert data.
    function trySelfRead(bytes memory data) internal view returns (bool ok, bytes memory ret) {
        LibPriceGuard.requireSelfReadGas();
        (ok, ret) = address(this).staticcall(data);
        if (!ok) passOnOutOfGas(ret);
    }

    /// @notice Revert {LibPriceGuard.PriceReadOutOfGas} when `reason` is that
    ///         error: a read that ran short of gas is passed on by name, never
    ///         read as a refusal.
    /// @param  reason The revert data of a failed call.
    function passOnOutOfGas(bytes memory reason) internal pure {
        if (reason.length == 4 && bytes4(reason) == LibPriceGuard.PriceReadOutOfGas.selector) {
            revert LibPriceGuard.PriceReadOutOfGas();
        }
    }
}
