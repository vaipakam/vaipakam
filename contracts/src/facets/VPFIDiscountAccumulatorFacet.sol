// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "../libraries/LibVaipakam.sol";
import {LibVPFIDiscount} from "../libraries/LibVPFIDiscount.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title VPFIDiscountAccumulatorFacet
 * @author Vaipakam Developer Team
 * @notice T-087 Sub 1.B — single-home facet for the heavy
 *         ring-buffer math + lifecycle bookkeeping the new
 *         time-weighted VPFI-discount surface depends on.
 *
 * @dev Why a separate facet:
 *
 *      The Solidity compiler inlines `internal` library functions
 *      into every consumer's bytecode. The T-087 ring-buffer
 *      accumulator (`_computeTwa` + `_computeRingBufferMinTier` +
 *      `_effectiveBalanceForDay` + `EnumerableSet.add/remove` +
 *      lifecycle bookkeeping) is ~2 kB of bytecode per inliner.
 *      With four settlement facets currently calling
 *      `LibVPFIDiscount.tryApplyYieldFee` (`RepayFacet`,
 *      `PrecloseFacet`, `RefinanceFacet`, plus the loan-init
 *      snapshot site in `LoanFacet`), inlining would breach
 *      EIP-170 on `RepayFacet` (≈26.9 kB > 24.6 kB) and
 *      `PrecloseFacet` (≈25.2 kB).
 *
 *      Carving the heavy code into ONE facet — accessed by every
 *      caller via a cross-facet delegatecall — keeps the
 *      consumer bytecode small (only the selector + calldata +
 *      `CALL` opcode) and the heavy math is a single bytecode
 *      blob the diamond routes to.
 *
 *      Self-call gate: every external method is restricted to
 *      `msg.sender == address(this)` so an EOA can NEVER invoke
 *      these directly. The wrappers in `LibVPFIDiscount` route
 *      through the Diamond's fallback (a `delegatecall`); from
 *      the facet's perspective, `msg.sender` resolves to the
 *      Diamond — i.e. `address(this)` inside the executing
 *      library context — passing the gate. A direct EOA call
 *      reverts.
 */
contract VPFIDiscountAccumulatorFacet {
    using EnumerableSet for EnumerableSet.AddressSet;

    error InternalCallerOnly();

    modifier onlyInternal() {
        if (msg.sender != address(this)) revert InternalCallerOnly();
        _;
    }

    /// @notice Append the user's post-mutation balance to the ring
    ///         buffer and update the lifecycle anchors + active-staker
    ///         registry. Gated to internal cross-facet calls only.
    /// @param  user            User whose accumulator is being rolled up.
    /// @param  balPostMutation The balance that will be in effect after
    ///                         the caller's vault mutation lands.
    function rollupUserDiscount(address user, uint256 balPostMutation)
        external
        onlyInternal
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint16 today = _todayId();
        uint16 prevUpdateDay = s.lastUpdateDayId[user];
        uint128 prevBal = _readLastKnownBalance(s, user, prevUpdateDay);
        _maintainStakerLifecycle(s, user, prevBal, balPostMutation, today);
        _advanceRingBuffer(s, user, balPostMutation, today, prevBal, prevUpdateDay);
    }

    /// @notice Resolve the user's current EFFECTIVE_TIER and
    ///         EFFECTIVE_BPS via the ring-buffer accumulator —
    ///         post-min-history gate and post-min-tier-over-history
    ///         clamp. Gated to internal cross-facet calls only.
    function effectiveTierAndBps(address user)
        external
        view
        onlyInternal
        returns (uint8 effTier, uint16 effBps)
    {
        LibVaipakam.Storage storage s = LibVaipakam.storageSlot();
        uint16 today = _todayId();

        uint40 startSec = s.currentStakeStartSec[user];
        if (startSec == 0) return (0, 0);
        uint256 minWindow =
            uint256(LibVaipakam.cfgTwaMinStakedDaysEffective()) * 1 days;
        if (block.timestamp < uint256(startSec) + minWindow) return (0, 0);

        uint256 twa = _computeTwa(s, user, today);
        uint8 rawTier = LibVPFIDiscount.tierOf(twa);
        if (rawTier == 0) return (0, 0);
        uint8 minOverHistory = _computeRingBufferMinTier(
            s,
            user,
            today,
            LibVaipakam.cfgTwaMinStakedDaysEffective()
        );
        effTier = rawTier < minOverHistory ? rawTier : minOverHistory;
        if (effTier == 0) return (0, 0);
        effBps = uint16(LibVPFIDiscount.discountBpsForTier(effTier));
    }

    // ─── Private helpers (see LibVPFIDiscount design comments for the
    //     rationale on each one; this file owns the implementations
    //     so they live in ONE bytecode blob) ─────────────────────────

    function _todayId() private view returns (uint16) {
        return uint16(block.timestamp / 1 days);
    }

    function _readLastKnownBalance(
        LibVaipakam.Storage storage s,
        address user,
        uint16 prevUpdateDay
    ) private view returns (uint128) {
        if (s.currentStakeStartSec[user] == 0) return 0;
        LibVaipakam.DaySnapshot storage snap =
            s.dayBalances[user][prevUpdateDay % 30];
        return snap.dayId == prevUpdateDay ? snap.balance : 0;
    }

    function _advanceRingBuffer(
        LibVaipakam.Storage storage s,
        address user,
        uint256 balPostMutation,
        uint16 today,
        uint128 prevBal,
        uint16 prevUpdateDay
    ) private {
        if (prevUpdateDay != 0 && prevUpdateDay < today) {
            uint16 gapStart = prevUpdateDay + 1;
            uint16 lowerBound = today > 29 ? today - 29 : 0;
            if (gapStart < lowerBound) gapStart = lowerBound;
            for (uint16 d = gapStart; d < today; d++) {
                s.dayBalances[user][d % 30] = LibVaipakam.DaySnapshot({
                    dayId: d,
                    balance: prevBal
                });
            }
        }
        s.dayBalances[user][today % 30] = LibVaipakam.DaySnapshot({
            dayId: today,
            balance: uint128(balPostMutation)
        });
        s.lastUpdateDayId[user] = today;
    }

    function _maintainStakerLifecycle(
        LibVaipakam.Storage storage s,
        address user,
        uint128 prevBal,
        uint256 newBal,
        uint16 today
    ) private {
        bool wasPositive = prevBal > 0;
        bool nowPositive = newBal > 0;
        if (!wasPositive && nowPositive) {
            s.currentStakeStartDayId[user] = today;
            s.currentStakeStartSec[user] = uint40(block.timestamp);
            s.activeStakerRegistry.add(user);
        } else if (wasPositive && !nowPositive) {
            s.currentStakeStartDayId[user] = 0;
            s.currentStakeStartSec[user] = 0;
            s.activeStakerRegistry.remove(user);
        }
    }

    function _computeTwa(
        LibVaipakam.Storage storage s,
        address user,
        uint16 today
    ) private view returns (uint256) {
        if (s.currentStakeStartSec[user] == 0) return 0;
        uint16 startDay = s.currentStakeStartDayId[user];
        uint16 windowDays = uint16(LibVaipakam.cfgTwaWindowDaysEffective());
        uint16 recentDays = uint16(LibVaipakam.cfgTwaRecentDaysEffective());
        uint256 recentWeight = LibVaipakam.cfgTwaRecentWeightEffective();
        uint16 windowFloor = today >= windowDays
            ? today - windowDays + 1
            : 0;
        if (startDay > windowFloor) windowFloor = startDay;
        uint16 recentFloor = today >= recentDays
            ? today - recentDays + 1
            : 0;
        uint256 weightedSum;
        uint256 weightSum;
        for (uint16 d = windowFloor; d <= today; d++) {
            uint128 bal = _effectiveBalanceForDay(s, user, d);
            uint256 w = d >= recentFloor ? recentWeight : 1;
            weightedSum += w * uint256(bal);
            weightSum += w;
        }
        if (weightSum == 0) return 0;
        return weightedSum / weightSum;
    }

    function _effectiveBalanceForDay(
        LibVaipakam.Storage storage s,
        address user,
        uint16 d
    ) private view returns (uint128) {
        LibVaipakam.DaySnapshot storage snap = s.dayBalances[user][d % 30];
        if (snap.dayId == d) return snap.balance;
        if (s.currentStakeStartSec[user] == 0) return 0;
        uint16 lastUpdate = s.lastUpdateDayId[user];
        if (lastUpdate >= d) return 0;
        LibVaipakam.DaySnapshot storage lastSnap =
            s.dayBalances[user][lastUpdate % 30];
        return lastSnap.dayId == lastUpdate ? lastSnap.balance : 0;
    }

    function _computeRingBufferMinTier(
        LibVaipakam.Storage storage s,
        address user,
        uint16 today,
        uint16 windowDays
    ) private view returns (uint8) {
        if (s.currentStakeStartSec[user] == 0) return 0;
        uint16 startDay = s.currentStakeStartDayId[user];
        uint16 windowFloor = today >= windowDays
            ? today - windowDays + 1
            : 0;
        if (startDay > windowFloor) windowFloor = startDay;
        uint8 minTier = type(uint8).max;
        bool anyHit;
        for (uint16 d = windowFloor; d <= today; d++) {
            uint128 bal = _effectiveBalanceForDay(s, user, d);
            uint8 t = LibVPFIDiscount.tierOf(uint256(bal));
            if (t < minTier) minTier = t;
            if (minTier == 0) return 0;
            anyHit = true;
        }
        return anyHit ? minTier : 0;
    }
}
