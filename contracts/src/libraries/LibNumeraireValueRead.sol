// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {NumeraireValueFacet} from "../facets/NumeraireValueFacet.sol";

/**
 * @title LibNumeraireValueRead
 * @author Vaipakam Developer Team
 * @notice The best-effort read of the one valuation rule (#2419): the value
 *         of an amount in the active numeraire, 1e18-scaled, for a caller
 *         that must carry on when the amount cannot be valued.
 *
 *         Analytics, the fee log, the periodic-interest cadence threshold
 *         and the treasury-conversion threshold read values this way. None
 *         of them may block what it is attached to (a settlement, an offer,
 *         a view) on a missing price, so each one takes `ok = false` and
 *         applies its own documented fallback. A binding risk or KYC check
 *         never reads through here: those revert by name instead
 *         (`NumeraireValueFacet.getNumeraireValue`).
 *
 * @dev    One self-call to `NumeraireValueFacet.getNumeraireValue`, the same
 *         rule the risk path reads, so a best-effort value can never differ
 *         from a binding one for the same asset, amount and rounding. A
 *         low-level `staticcall` rather than `try/catch` so that EVERY
 *         failure of the rule is caught here: a missing, stale or distrusted
 *         price, a zero price, unreadable token decimals, an unsupported
 *         scale and an arithmetic overflow, and an unrouted selector on a
 *         Diamond that does not carry the rule. A short answer reads as a
 *         failure too, never as a value.
 */
library LibNumeraireValueRead {
    /// @notice Value of `amount` base units of `asset`, in 1e18 numeraire,
    ///         by the shared rule, never reverting.
    /// @param asset   Token to value. The zero address is never valued.
    /// @param amount  Amount in `asset`'s base units. Zero is valued like any
    ///                other amount (0 when the asset is priced), so a caller
    ///                can still tell "unpriced" from "nothing to value".
    /// @param roundUp True rounds up, false down (a value compared against a
    ///                threshold, or reported as a total).
    /// @return ok     False when the rule refused; `value` is then 0 and must
    ///                not be read as a valuation.
    /// @return value  The 1e18-scaled numeraire value.
    function tryValue(address asset, uint256 amount, bool roundUp)
        internal
        view
        returns (bool ok, uint256 value)
    {
        if (asset == address(0)) return (false, 0);
        (bool success, bytes memory ret) = address(this).staticcall(
            abi.encodeCall(NumeraireValueFacet.getNumeraireValue, (asset, amount, roundUp))
        );
        if (!success || ret.length < 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    /// @notice {tryValue} rounded down, with a refusal read as 0 — the form
    ///         a reported total or a "clears the threshold?" test takes, where
    ///         an unvalued amount counts for nothing.
    function valueOrZero(address asset, uint256 amount) internal view returns (uint256 value) {
        (, value) = tryValue(asset, amount, false);
    }
}
