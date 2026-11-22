// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {IRateReference} from "./IRateReference.sol";

/**
 * @title  IRateReferenceReads
 * @author Vaipakam Developer Team
 * @notice The read side of the rate reference (#3713): the term average, the
 *         window a market-linked limit reads, the linked rate and the warning
 *         band. Built only from the reference's own averaged reads and
 *         settings; it holds no state. Found through
 *         {IRateReference.READS}.
 */
interface IRateReferenceReads {
    /// @notice The reference these reads are built from.
    function REFERENCE() external view returns (IRateReference);

    /// @notice The "market unusual" state of `asset`'s reference: its
    ///         24-hour average against its 30-day average.
    function unusual(address asset) external view returns (IRateReference.Unusual);

    /// @notice The state of `asset`'s newest series, carried to now.
    function status(address asset) external view returns (IRateReference.Status memory);

    /// @notice The weight on the 24-hour average for a term of `termDays`.
    function weightBps(uint256 termDays) external view returns (uint16);

    /// @notice The term average for a loan of `termDays` (#3713 section 6.2).
    function termAverage(address asset, uint256 termDays)
        external
        view
        returns (IRateReference.TermAverage memory);

    /// @notice The window a market-linked limit reads for a loan of
    ///         `termDays` (#3713 section 3).
    function windowForTerm(uint256 termDays) external view returns (uint256);

    /// @notice The rate a link of `kind` produces for a loan of `termDays`
    ///         now, before the maker's margin, or why it cannot be used.
    ///         The window follows the term (24 hours up to 30 days, 7 days up
    ///         to 365, 30 days beyond); a term over 30 days waits while the
    ///         reference is unusual or its state is not known.
    function linkedRate(address asset, uint256 termDays, IRateReference.LinkKind kind)
        external
        view
        returns (uint256 rate1e18, IRateReference.LinkRefusal refusal);

    /// @notice Where a fixed rate of `rateBps` for `termDays` sits against
    ///         the warning band.
    function band(address asset, uint256 termDays, uint256 rateBps)
        external
        view
        returns (IRateReference.Band memory);
}
