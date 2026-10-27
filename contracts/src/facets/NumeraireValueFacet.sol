// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibNumeraireValue} from "../libraries/LibNumeraireValue.sol";
import {OracleFacet} from "./OracleFacet.sol";
import {LibVaipakam} from "../libraries/LibVaipakam.sol";

/**
 * @title NumeraireValueFacet
 * @author Vaipakam Developer Team
 * @notice Values a token amount in the active numeraire, and converts a
 *         numeraire value back to a token amount, through the one shared
 *         rule in {LibNumeraireValue} (#2419). Every value is 1e18-scaled:
 *         `1e18` is one numeraire unit.
 * @dev    A separate facet rather than an `OracleFacet` addition: the rule
 *         is valuation, not price discovery, and `OracleFacet` has too
 *         little EIP-170 headroom to host it. Facets near the limit
 *         (`RiskFacet`, the offer facets that inline `LibRiskMath`) reach
 *         the rule through these two views instead of inlining the full-
 *         precision arithmetic, and every KYC comparison values its
 *         amounts through {getLiquidNumeraireValue}. The price is `OracleFacet.getAssetPrice`,
 *         read through the Diamond, so its staleness, sequencer, secondary-
 *         quorum and zero-price refusals all apply and bubble unchanged (the
 *         rule refuses a zero price itself too, whatever the oracle's
 *         version: {LibNumeraireValue.PriceZero}); a
 *         token whose `decimals()` cannot be read reverts
 *         {LibNumeraireValue.TokenDecimalsUnreadable}. Views only: no
 *         storage, no state change.
 */
contract NumeraireValueFacet {
    /// @notice Value of `amount` base units of `asset`, in 1e18 numeraire.
    /// @param asset   ERC-20 to value. Must have a price.
    /// @param amount  Amount in `asset`'s base units.
    /// @param roundUp True rounds up (a debt leg), false down (a collateral
    ///                leg, or a value compared against a threshold).
    function getNumeraireValue(address asset, uint256 amount, bool roundUp)
        external
        view
        returns (uint256 value)
    {
        (uint256 price, uint8 feedDecimals) = OracleFacet(address(this)).getAssetPrice(asset);
        value = LibNumeraireValue.toValue(
            amount,
            price,
            feedDecimals,
            LibNumeraireValue.tokenDecimals(asset),
            roundUp
        );
    }

    /// @notice Value of `amount` base units of `asset`, in 1e18 numeraire,
    ///         counting only a liquid asset — the figure a KYC threshold is
    ///         compared against.
    /// @dev    An asset `OracleFacet.checkLiquidity` does not classify Liquid
    ///         has no trusted price and is valued at 0 (README: illiquid
    ///         assets count for nothing in a KYC comparison). A liquid asset
    ///         is valued by the shared rule, rounded down (a value compared
    ///         against a threshold). A zero amount is worth 0 without a
    ///         price read, so an empty leg — a rental's collateral, which
    ///         names no asset (#2949) — values as nothing rather than
    ///         reverting on the missing asset.
    /// @param asset  Token to value.
    /// @param amount Amount in `asset`'s base units.
    function getLiquidNumeraireValue(address asset, uint256 amount)
        external
        view
        returns (uint256 value)
    {
        if (amount == 0) return 0;
        if (
            OracleFacet(address(this)).checkLiquidity(asset)
                != LibVaipakam.LiquidityStatus.Liquid
        ) return 0;
        (uint256 price, uint8 feedDecimals) = OracleFacet(address(this)).getAssetPrice(asset);
        value = LibNumeraireValue.toValue(
            amount,
            price,
            feedDecimals,
            LibNumeraireValue.tokenDecimals(asset),
            false
        );
    }

    /// @notice Amount of `asset`, in base units, worth `value` (1e18
    ///         numeraire) — the inverse of {getNumeraireValue}.
    /// @param asset   ERC-20 to convert into. Must have a price.
    /// @param value   Numeraire value, 1e18-scaled.
    /// @param roundUp True returns the smallest amount whose value (rounded
    ///                down) reaches `value` — a collateral floor. False
    ///                returns the largest amount whose value (rounded up)
    ///                stays within `value` — a debt ceiling.
    function getAmountForNumeraireValue(address asset, uint256 value, bool roundUp)
        external
        view
        returns (uint256 amount)
    {
        (uint256 price, uint8 feedDecimals) = OracleFacet(address(this)).getAssetPrice(asset);
        amount = LibNumeraireValue.toAmount(
            value,
            price,
            feedDecimals,
            LibNumeraireValue.tokenDecimals(asset),
            roundUp
        );
    }
}
