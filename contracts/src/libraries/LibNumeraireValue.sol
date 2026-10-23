// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title LibNumeraireValue
 * @author Vaipakam Developer Team
 * @notice The ONE rule for turning a token amount into a value in the
 *         active numeraire, and back (#2419).
 *
 *         A value is a fixed-point number with {VALUE_DECIMALS} (18)
 *         decimals: `1e18` is one numeraire unit (one US dollar on the
 *         post-deploy default). Given an oracle price with `feedDecimals`
 *         decimals for one WHOLE token, and a token with `tokenDecimals`:
 *
 *             value = amount × price × 1e18 ÷ 10^(feedDecimals + tokenDecimals)
 *
 *         computed in full precision (one rounding, in the direction the
 *         caller names) — never as two successive divisions, and never in
 *         whole numeraire units, so a small amount keeps its precision.
 *
 * @dev    Pure arithmetic plus a guarded `decimals()` read. Facets close to
 *         EIP-170 read it through `NumeraireValueFacet` instead of inlining
 *         it, so the rule exists once in source and once per inlining
 *         contract in bytecode, never as a second formula.
 *
 *         Rounding is the caller's decision, because only the caller knows
 *         which direction is conservative for it. The convention the
 *         protocol uses: a DEBT or principal leg rounds UP, a COLLATERAL leg
 *         rounds DOWN, and a threshold comparison (KYC, metrics) rounds DOWN.
 */
library LibNumeraireValue {
    /// @notice Decimals of every value this library produces.
    uint256 internal constant VALUE_DECIMALS = 18;

    /// @notice Largest token `decimals()` the protocol prices. A token
    ///         reporting more is treated as unreadable: its amounts cannot
    ///         be scaled without risking an overflow inside a view that
    ///         must not revert, and no listed asset comes close.
    uint8 internal constant MAX_TOKEN_DECIMALS = 36;

    /// @notice `feedDecimals + tokenDecimals` is so far above
    ///         {VALUE_DECIMALS} that `10^(sum − 18)` does not fit in 256 bits.
    error NumeraireScaleUnsupported(uint256 decimalsSum);

    /// @notice A zero price was handed to the rule. It is refused HERE, not
    ///         only in `OracleFacet.getAssetPrice`, so no caller of the rule
    ///         can value a nonzero debt at nothing (or divide by zero in
    ///         {toAmount}) whichever oracle version it reads from.
    error PriceZero();

    /// @notice `token` answered `decimals()` with no readable value, or with
    ///         one above {MAX_TOKEN_DECIMALS}.
    error TokenDecimalsUnreadable(address token);

    /// @notice Value of `amount` base units at `price`, in 1e18 numeraire.
    /// @param amount        Token amount, in the token's base units.
    /// @param price         Oracle price of one whole token.
    /// @param feedDecimals  Decimals of `price`.
    /// @param tokenDecimals The token's own `decimals()`.
    /// @param roundUp       True rounds the single division up, false down.
    function toValue(
        uint256 amount,
        uint256 price,
        uint8 feedDecimals,
        uint8 tokenDecimals,
        bool roundUp
    ) internal pure returns (uint256 value) {
        if (price == 0) revert PriceZero();
        uint256 scale = uint256(feedDecimals) + uint256(tokenDecimals);
        if (scale >= VALUE_DECIMALS) {
            uint256 gap = scale - VALUE_DECIMALS;
            if (gap > 77) revert NumeraireScaleUnsupported(scale); // 10^gap < 2^256
            value = Math.mulDiv(amount, price, 10 ** gap, _rounding(roundUp));
        } else {
            // Exact: no division at all, so no rounding. Overflow reverts.
            value = amount * price * (10 ** (VALUE_DECIMALS - scale));
        }
    }

    /// @notice Token amount, in base units, whose value at `price` is
    ///         `value` (1e18 numeraire) — the inverse of {toValue}.
    /// @dev    With `roundUp`, the result is the SMALLEST amount whose
    ///         {toValue} rounded down is at least `value`; without it, the
    ///         LARGEST amount whose {toValue} rounded up is at most `value`.
    ///         So a floor on collateral asks for `roundUp`, a ceiling on debt
    ///         does not.
    function toAmount(
        uint256 value,
        uint256 price,
        uint8 feedDecimals,
        uint8 tokenDecimals,
        bool roundUp
    ) internal pure returns (uint256 amount) {
        if (price == 0) revert PriceZero();
        uint256 scale = uint256(feedDecimals) + uint256(tokenDecimals);
        if (scale >= VALUE_DECIMALS) {
            uint256 gap = scale - VALUE_DECIMALS;
            if (gap > 77) revert NumeraireScaleUnsupported(scale);
            amount = Math.mulDiv(value, 10 ** gap, price, _rounding(roundUp));
        } else {
            amount = Math.mulDiv(value, 1, price * (10 ** (VALUE_DECIMALS - scale)), _rounding(roundUp));
        }
    }

    /// @notice `decimals()` of `token`, refusing by name when it cannot be
    ///         read ({TokenDecimalsUnreadable}).
    function tokenDecimals(address token) internal view returns (uint8 decimals) {
        bool ok;
        (ok, decimals) = tryTokenDecimals(token);
        if (!ok) revert TokenDecimalsUnreadable(token);
    }

    /// @notice `decimals()` of `token`, never reverting. `ok` is false for an
    ///         address with no code, a failed or short answer, or a value
    ///         above {MAX_TOKEN_DECIMALS}; `decimals` is then 0 and must not
    ///         be used.
    /// @dev    A low-level `staticcall`, because `try/catch` does not catch a
    ///         call to a code-less address: it succeeds with empty returndata
    ///         and the compiler's decode guard then reverts outside the catch.
    function tryTokenDecimals(address token) internal view returns (bool ok, uint8 decimals) {
        if (token.code.length == 0) return (false, 0);
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!success || data.length < 32) return (false, 0);
        uint256 d = abi.decode(data, (uint256));
        if (d > MAX_TOKEN_DECIMALS) return (false, 0);
        return (true, uint8(d));
    }

    function _rounding(bool roundUp) private pure returns (Math.Rounding) {
        return roundUp ? Math.Rounding.Ceil : Math.Rounding.Floor;
    }
}
