// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

/**
 * @title  IRateReader
 * @notice A small fixed reader the price guard asks for a rate-priced token's
 *         exchange rate when the token's own conversion function is its rate
 *         source (#3683, `RatePricedCollateralDesign.md` section 3). One
 *         reader per token type; it holds no settings and has no owner.
 */
interface IRateReader {
    /// @notice How many whole `underlying` one whole `token` is redeemable
    ///         for now, scaled by 1e18. Reverts when the token cannot say,
    ///         or when `underlying` is not the token's underlying.
    function rate(address token, address underlying) external view returns (uint256 rate1e18);
}
