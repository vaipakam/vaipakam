// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibBackstopDailyLimit
 * @author Vaipakam Developer Team
 * @notice #3849 — the one rule for how much the backstop (Role A) may lend in
 *         one lending asset on one UTC day: a governed share of its lending
 *         capital in that asset, where the capital is the funded capital
 *         waiting across the asset's pairs plus the principal out on its open
 *         loans.
 * @dev    Inlined in two facets:
 *         - `MarketLedgerFacet`, the one place every loan opened from an
 *           Auto-lend slot's capital passes (`onSlotFilled`: an intent match,
 *           an instant fill and a takeover into a slot), which counts a
 *           backstop opening against the day and refuses one over the limit
 *           ({consume}); and the slot sync every writer of a slot's capital or
 *           live principal reaches, which keeps the per-asset capital
 *           ({syncPair}). So the capital is a running total and no fill
 *           iterates pairs or loans.
 *         - `BackstopFacet`, for the setting, the opt-in refusal and the view.
 *
 *         A fill moves capital from waiting to out and leaves the sum
 *         unchanged, so a fill never moves the day's limit. A seed, a
 *         withdrawal to treasury, a repayment, a default or a write-off does.
 *
 *         Role B (the buyout and absorb) never reaches `onSlotFilled` with the
 *         backstop's slot as origin, so it is not counted (#3849 item 8).
 *
 *         Stated limits: the day is the UTC day, so a stretch across midnight
 *         can use two days' limits; the day's room is first come, first
 *         served; and a seed made during the day raises that day's limit at
 *         once (a seed is a governance step behind the timelock).
 */
library LibBackstopDailyLimit {
    /// @notice The share used when governance has set none: one fifth.
    uint16 internal constant DEFAULT_BPS = 2_000;
    /// @notice The lowest share the setting may take.
    uint16 internal constant MIN_BPS = 500;
    /// @notice The highest share the setting may take.
    uint16 internal constant MAX_BPS = 5_000;

    /// @notice A backstop opening of `amount` in `asset` would take the day's
    ///         total over its limit. `usedToday` is what the backstop has
    ///         already lent in the asset today and `dayEnd` the time (UTC
    ///         seconds) the day's total resets.
    error BackstopDailyLimitExceeded(
        address asset,
        uint256 amount,
        uint256 limit,
        uint256 usedToday,
        uint64 dayEnd
    );

    /// @notice An offer of `amount` in `asset` is larger than the backstop's
    ///         whole daily limit in the asset, so the backstop (which fills
    ///         whole offers only) cannot fill it today. Raised by the opt-in.
    error BackstopOfferAboveDailyLimit(address asset, uint256 amount, uint256 limit);

    /// @notice The share in force: the governed value, or {DEFAULT_BPS} when
    ///         none was set. Never zero.
    function bps(LibVaipakam.Storage storage s) internal view returns (uint16 b) {
        b = s.backstopDailyLimitBps;
        if (b == 0) b = DEFAULT_BPS;
    }

    /// @notice The current UTC day number and the time it ends.
    function today() internal view returns (uint64 day, uint64 dayEnd) {
        day = uint64(block.timestamp / 1 days);
        dayEnd = (day + 1) * 1 days;
    }

    /// @notice The day's limit in `asset`: the share in force of the
    ///         backstop's lending capital in it, rounded down.
    function limitOf(LibVaipakam.Storage storage s, address asset) internal view returns (uint256) {
        return (s.backstopCapital[asset] * bps(s)) / 10_000;
    }

    /// @notice What the backstop lent in `asset` today.
    function usedToday(LibVaipakam.Storage storage s, address asset) internal view returns (uint256) {
        LibVaipakam.BackstopDayUse storage u = s.backstopDayUse[asset];
        (uint64 day, ) = today();
        return u.day == day ? u.used : 0;
    }

    /// @notice Count a backstop opening of `amount` in `asset` against today,
    ///         refusing it when the day's total would pass the limit.
    function consume(LibVaipakam.Storage storage s, address asset, uint256 amount) internal {
        (uint64 day, uint64 dayEnd) = today();
        LibVaipakam.BackstopDayUse storage u = s.backstopDayUse[asset];
        uint256 used = u.day == day ? u.used : 0;
        uint256 limit = limitOf(s, asset);
        if (used + amount > limit) {
            revert BackstopDailyLimitExceeded(asset, amount, limit, used, dayEnd);
        }
        u.day = day;
        // Fits: `used + amount <= limit`, and the limit is a share of a token
        // amount held in a vault.
        u.used = uint192(used + amount);
    }

    /// @notice Bring the backstop's per-asset capital up to date with one of
    ///         its slots: `slotTotal` is the slot's reserved capital plus its
    ///         live principal now. A no-op for any other owner, and for a slot
    ///         other than the protocol slot (the backstop runs that one only).
    function syncPair(
        LibVaipakam.Storage storage s,
        address owner,
        address lend,
        address coll,
        uint8 slot,
        uint256 slotTotal
    ) internal {
        if (owner != s.backstopVault || owner == address(0) || slot != LibVaipakam.PROTOCOL_INTENT_SLOT) return;
        uint256 old = s.backstopPairCapital[lend][coll];
        if (old == slotTotal) return;
        s.backstopPairCapital[lend][coll] = slotTotal;
        // `backstopCapital[lend]` is the sum of the pair figures, so it is at
        // least `old`.
        s.backstopCapital[lend] = s.backstopCapital[lend] - old + slotTotal;
    }
}
