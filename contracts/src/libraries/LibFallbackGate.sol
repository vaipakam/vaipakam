// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title LibFallbackGate
 * @notice #3538 — the one rule for when a terminal forced sale whose listed
 *         swap routes all failed may move the loan into the in-kind fallback.
 *
 *         The HF liquidation and the time-based default are permissionless,
 *         and the caller writes the swap try-list. #1005 refuses a list with
 *         no enabled route, but one enabled route with deliberately broken
 *         data still counts as a real attempt, so one transaction could move
 *         a loan with a healthy market into in-kind custody. The rule here
 *         makes that take TIME instead of one transaction: a failed sale
 *         opens the fallback only when an earlier failed sale of the same
 *         loan, from any caller, is at least {MIN_SPAN} old. Until then the
 *         failed sale is undone and only recorded, and anyone with a working
 *         route can sell in between.
 *
 *         A record goes stale after {STALE_AFTER}: a loan that recovered and
 *         later becomes liquidatable again starts a new record, so an old
 *         failure cannot open the fallback for a new episode in one step.
 *
 *         The record is written only by `ForcedSaleFacet.sellToNeed`; this
 *         library holds the rule, so the facet and the views read one rule.
 */
library LibFallbackGate {
    /// @notice The least time between the first failed sale and the one that
    ///         may open the fallback.
    uint256 internal constant MIN_SPAN = 10 minutes;

    /// @notice A record whose latest failure is older than this is ignored,
    ///         and the next failure starts a new one.
    uint256 internal constant STALE_AFTER = 1 days;

    /// @notice The loan's record as the rule reads it now: a stale record
    ///         reads as empty.
    function current(uint256 loanId) internal view returns (LibVaipakam.FallbackGate memory g) {
        g = LibVaipakam.storageSlot().fallbackGate[loanId];
        if (g.fails != 0 && block.timestamp > uint256(g.lastFailAt) + STALE_AFTER) {
            g = LibVaipakam.FallbackGate(0, 0, 0);
        }
    }

    /// @notice Whether a sale failing NOW may open the fallback: an earlier
    ///         failure in the current record is at least {MIN_SPAN} old.
    function opensNow(uint256 loanId) internal view returns (bool) {
        LibVaipakam.FallbackGate memory g = current(loanId);
        return g.fails != 0 && block.timestamp >= uint256(g.firstFailAt) + MIN_SPAN;
    }

    /// @notice The earliest time a failed sale may open the fallback, given
    ///         the current record: 0 when there is no record yet (the first
    ///         failure starts the span), else the first failure plus
    ///         {MIN_SPAN}.
    function opensAt(uint256 loanId) internal view returns (uint256) {
        LibVaipakam.FallbackGate memory g = current(loanId);
        return g.fails == 0 ? 0 : uint256(g.firstFailAt) + MIN_SPAN;
    }

    /// @notice Records a failed sale now. Returns the record as written.
    function recordFailure(uint256 loanId) internal returns (LibVaipakam.FallbackGate memory g) {
        g = current(loanId);
        uint40 nowTs = uint40(block.timestamp);
        if (g.fails == 0) g.firstFailAt = nowTs;
        g.lastFailAt = nowTs;
        unchecked {
            g.fails += 1;
        }
        LibVaipakam.storageSlot().fallbackGate[loanId] = g;
    }
}
