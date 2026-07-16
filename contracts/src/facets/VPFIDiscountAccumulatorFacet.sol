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
        _rollupCore(s, user, balPostMutation);

        // T-087 Sub 2.D — protocol-funded mirror broadcast via cross-
        // facet call to `ProtocolBroadcastFacet`.
        //
        // Codex Sub 2.D round-2 P1 #2 — the previous failure-mode
        // discriminator (swallow `FunctionDoesNotExist()`, bubble
        // everything else) was unsafe: the same selector is returned
        // when a misconfigured `rewardMessenger` is pointed at a
        // contract that doesn't implement `sendTierUpdate` — exactly
        // the case where we MUST bubble to surface the misconfig.
        //
        // Replaced by a direct on-chain configuration check: if
        // `rewardMessenger == address(0)` the broadcast surface
        // isn't wired (the deploy-time default + every minimal-
        // fixture test), so we skip the call entirely. Once a
        // messenger IS set, the call goes through and ANY revert
        // from inside the broadcast facet (including
        // `ProtocolBudgetExhausted`) bubbles correctly. This makes
        // a missing `ProtocolBroadcastFacet` cut a deploy-time
        // mistake the predeploy sanity catches rather than a
        // silent runtime degrade.
        if (s.rewardMessenger != address(0)) {
            // slither-disable-next-line low-level-calls
            (bool ok, bytes memory returnData) = address(this).call(
                abi.encodeWithSignature(
                    "protocolBroadcastTierUpdate(address)", user
                )
            );
            if (!ok) {
                assembly {
                    revert(add(32, returnData), mload(returnData))
                }
            }
        }
    }

    /// @notice RL-1 (VpfiRecyclingLoopClosureDesign §6) — broadcast-FREE
    ///         sibling of {rollupUserDiscount}. Runs the identical local
    ///         ring-buffer + lifecycle + expiry writes but deliberately
    ///         skips the CCIP tier push.
    /// @dev    Used by the Diamond-funded vault credit primitive
    ///         ({VaultFactoryFacet.vaultCreditFromDiamondERC20}) on the
    ///         reward claim-to-vault path: a claim must never inherit the
    ///         broadcast path's failure modes (`ProtocolBudgetExhausted`,
    ///         messenger misconfig) when today's wallet claim would have
    ///         succeeded. The push is an optimization, not a correctness
    ///         requirement — the user's NEXT balance mutation (or any
    ///         keeper poke) runs the broadcasting rollup and carries the
    ///         tier update to mirrors; until then mirrors serve the
    ///         previously-pushed cache, exactly as they do between any two
    ///         mutations. Gated to internal cross-facet calls only.
    /// @param  user            User whose accumulator is being rolled up.
    /// @param  balPostMutation The balance in effect after the caller's
    ///                         vault mutation lands.
    function rollupUserDiscountLocal(address user, uint256 balPostMutation)
        external
        onlyInternal
    {
        _rollupCore(LibVaipakam.storageSlot(), user, balPostMutation);
    }

    /// @dev Shared local-write body of the two rollup entries: ring-buffer
    ///      advance, staker-lifecycle maintenance, and the projected
    ///      tier-expiry stamp. Broadcast policy is the CALLER's concern.
    function _rollupCore(
        LibVaipakam.Storage storage s,
        address user,
        uint256 balPostMutation
    ) private {
        uint16 today = _todayId();
        uint16 prevUpdateDay = s.lastUpdateDayId[user];
        uint120 prevBal = _readLastKnownBalance(s, user, prevUpdateDay);
        _maintainStakerLifecycle(s, user, prevBal, balPostMutation, today);
        _advanceRingBuffer(s, user, balPostMutation, today, prevBal, prevUpdateDay);
        // T-087 Sub 2.A — replace the old `type(uint40).max` sentinel
        // (which Sub 1.B / 1.C wrote unconditionally as a placeholder)
        // with the actual projected expiry. The scan walks the future
        // trajectory of the ring buffer assuming the user holds the
        // current balance forever, and finds the first day on which
        // the projected TWA crosses below the current EFFECTIVE_TIER
        // boundary. The mirror cache's freshness gate now has a
        // meaningful timestamp to compare against (design §4.3 +
        // round-3 P1 #1).
        s.tierExpirySec[user] = _computeProjectedTierExpiry(
            s,
            user,
            today,
            uint120(balPostMutation)
        );
    }

    /// @notice T-087 Sub 2.A — read the user's projected tier-expiry
    ///         timestamp. Computed at every rollup pass; the value
    ///         is what the Sub 2.B `TierUpdated` CCIP payload will
    ///         carry and what mirror caches enforce locally
    ///         (`block.timestamp < cache.tierExpirySec` per Sub 1.C
    ///         freshness gate). Returns `type(uint40).max` when no
    ///         decay is projected within the 30-day ring buffer
    ///         window — the "no expiry" sentinel (round-6 P1 #9).
    /// @dev    Public read; off-chain monitoring + tests both consume
    ///         this. NOT `onlyInternal` because there's no security
    ///         posture against reading a public timestamp.
    function getTierExpirySec(address user) external view returns (uint40) {
        // Codex Sub 2.A round-3 P2 — fall through to the sentinel
        // when storage reads 0. A never-rolled-up user (state
        // predates this facet cut, or first-rollup-not-yet-fired)
        // would otherwise surface `0`, which any
        // `block.timestamp < tierExpirySec` consumer would read as
        // "expired since epoch". Sentinel is the correct null
        // semantics — "no projected expiry".
        uint40 stored = LibVaipakam.storageSlot().tierExpirySec[user];
        return stored == 0 ? type(uint40).max : stored;
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
    ) private view returns (uint120) {
        // Returns the close-of-day balance from the last written
        // slot — this is the "balance the user actually held at the
        // end of that day", which gap-fill should extend forward,
        // NOT the dayMin (which is the conservative tier-clamp
        // value for that specific day).
        if (s.currentStakeStartSec[user] == 0) return 0;
        LibVaipakam.DaySnapshot storage snap =
            s.dayBalances[user][prevUpdateDay % 30];
        return snap.dayId == prevUpdateDay ? snap.dayClose : 0;
    }

    function _advanceRingBuffer(
        LibVaipakam.Storage storage s,
        address user,
        uint256 balPostMutation,
        uint16 today,
        uint120 prevBal,
        uint16 prevUpdateDay
    ) private {
        // Gap-fill condition uses `prevUpdateDay < today` only — NOT
        // `prevUpdateDay != 0 && ...`. The original `!= 0` guard
        // intended to skip the gap-fill on the very first interaction
        // (when no prior write existed) but mis-fired for a user
        // whose legitimate first stake landed on `dayId == 0`:
        // a later rollup at `today = N` would skip the gap-fill,
        // leaving slots 1..N-1 as default `dayId = 0` snapshots, and
        // `_effectiveBalanceForDay` would return 0 for those days
        // because the fallback branch reads `lastUpdate >= d` as
        // "no extension available" (Codex Sub 1.B P2 #2).
        //
        // The 30-iteration lower bound below caps the loop, so a
        // true first-ever stake on `today = 20 000+` doesn't loop
        // 20 000 times. For a fresh user the gap-fill writes
        // `prevBal = 0` into the pre-stake slots, which is correct
        // (the user actually had 0 balance on those days), and the
        // TWA scanner filters them via the `currentStakeStartDayId`
        // floor (round-10 P1 #2) so they don't enter the average.
        if (prevUpdateDay < today) {
            uint16 gapStart = prevUpdateDay + 1;
            uint16 lowerBound = today > 29 ? today - 29 : 0;
            if (gapStart < lowerBound) gapStart = lowerBound;
            for (uint16 d = gapStart; d < today; d++) {
                // Balance was unchanged during the gap, so the day's
                // min and close are identical (= the prior day's
                // close).
                s.dayBalances[user][d % 30] = LibVaipakam.DaySnapshot({
                    dayId: d,
                    dayMin: prevBal,
                    dayClose: prevBal
                });
            }
        }
        // Sub 1.C — split the slot into (dayMin, dayClose):
        //   - `dayMin` is what the min-tier-over-history clamp
        //     scans. Same-day rollups KEEP THE MINIMUM so a
        //     dust-then-bulk attacker (round-10 P1 #5 + Sub 1.B
        //     round-2 P1) can't erase their dust morning by topping
        //     up before midnight.
        //   - `dayClose` is what TWA + future gap-fill read. Same-
        //     day rollups OVERWRITE dayClose with the latest
        //     balance, so the next day's gap-fill extends the
        //     user's actual current balance forward, not the
        //     historical min. Without this split a legitimate user
        //     who staked 1 wei dust then immediately topped up to
        //     a real tier stayed stuck at 1 wei in every future
        //     read until any later-day mutation (Sub 1.B round-3
        //     P2 #3).
        //
        // The "first write of the day vs. same-day overwrite"
        // disambiguation still gates on `prevUpdateDay == today &&
        // prevBal > 0` (the default-zero slot on epoch day 0 with a
        // fresh user has `prevBal == 0`, which routes to the
        // overwrite branch — preserves the Sub 1.B round-2 P2 fix).
        uint120 newBal = uint120(balPostMutation);
        LibVaipakam.DaySnapshot storage todaySlot =
            s.dayBalances[user][today % 30];
        if (prevUpdateDay == today && prevBal > 0) {
            if (newBal < todaySlot.dayMin) {
                todaySlot.dayMin = newBal;
            }
            todaySlot.dayClose = newBal;
        } else {
            todaySlot.dayId = today;
            todaySlot.dayMin = newBal;
            todaySlot.dayClose = newBal;
        }
        s.lastUpdateDayId[user] = today;
    }

    function _maintainStakerLifecycle(
        LibVaipakam.Storage storage s,
        address user,
        uint120 prevBal,
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
        // Sub 1.C: TWA scan reads `dayClose` — the day's end-of-day
        // balance is the best single-value approximation we have
        // for the day's average contribution to the user's history.
        for (uint16 d = windowFloor; d <= today; d++) {
            uint120 bal = _effectiveDayClose(s, user, d);
            uint256 w = d >= recentFloor ? recentWeight : 1;
            weightedSum += w * uint256(bal);
            weightSum += w;
        }
        if (weightSum == 0) return 0;
        return weightedSum / weightSum;
    }

    /// @dev Day-`d` close-of-day balance — read by the TWA + by
    ///      gap-fill extension to days past `lastUpdateDayId`. Falls
    ///      back to the slot at `lastUpdateDayId` when day `d` was
    ///      not directly written; returns 0 when the user has no
    ///      current stake.
    function _effectiveDayClose(
        LibVaipakam.Storage storage s,
        address user,
        uint16 d
    ) private view returns (uint120) {
        LibVaipakam.DaySnapshot storage snap = s.dayBalances[user][d % 30];
        if (snap.dayId == d) return snap.dayClose;
        if (s.currentStakeStartSec[user] == 0) return 0;
        uint16 lastUpdate = s.lastUpdateDayId[user];
        if (lastUpdate >= d) return 0;
        LibVaipakam.DaySnapshot storage lastSnap =
            s.dayBalances[user][lastUpdate % 30];
        return lastSnap.dayId == lastUpdate ? lastSnap.dayClose : 0;
    }

    /// @dev Day-`d` minimum balance — read by the
    ///      min-tier-over-history clamp. For directly-written days,
    ///      returns `dayMin` (the lowest balance observed on that
    ///      day, the field that holds dust-history through a
    ///      same-day overwrite). For gap-filled days (no mutation
    ///      since `lastUpdateDayId`), the user held the
    ///      close-of-day balance throughout — so `dayMin = dayClose`
    ///      for those days and the helper extends the last slot's
    ///      `dayClose` forward.
    function _effectiveDayMin(
        LibVaipakam.Storage storage s,
        address user,
        uint16 d
    ) private view returns (uint120) {
        LibVaipakam.DaySnapshot storage snap = s.dayBalances[user][d % 30];
        if (snap.dayId == d) return snap.dayMin;
        if (s.currentStakeStartSec[user] == 0) return 0;
        uint16 lastUpdate = s.lastUpdateDayId[user];
        if (lastUpdate >= d) return 0;
        LibVaipakam.DaySnapshot storage lastSnap =
            s.dayBalances[user][lastUpdate % 30];
        return lastSnap.dayId == lastUpdate ? lastSnap.dayClose : 0;
    }

    function _computeRingBufferMinTier(
        LibVaipakam.Storage storage s,
        address user,
        uint16 today,
        uint16 windowDays
    ) private view returns (uint8) {
        if (s.currentStakeStartSec[user] == 0) return 0;
        uint16 startDay = s.currentStakeStartDayId[user];
        // Sub 1.C round-1 P2 #4: the scan must extend BACK to
        // `currentStakeStartDayId` (capped at the 30-day ring buffer
        // window) so a dust-then-bulk attacker whose dust day has
        // fallen out of the `today - minDays + 1` window is still
        // caught. With the previous `if (startDay > windowFloor)
        // windowFloor = startDay` narrowing, a user who staked
        // dust on day 0, topped up the same day, and read tier on
        // day 3 saw the scan start at day 1 — missing the dust
        // dayMin entirely. The new logic widens the floor down to
        // the earlier of `today - minDays + 1` or `startDay`,
        // bounded below by `today - 29` to stay within the ring
        // buffer's active range.
        uint16 lowerCap = today > 29 ? today - 29 : 0;
        uint16 windowFloor = today >= windowDays
            ? today - windowDays + 1
            : 0;
        if (startDay < windowFloor) windowFloor = startDay;
        if (windowFloor < lowerCap) windowFloor = lowerCap;
        uint8 minTier = type(uint8).max;
        bool anyHit;
        for (uint16 d = windowFloor; d <= today; d++) {
            uint120 bal = _effectiveDayMin(s, user, d);
            uint8 t = LibVPFIDiscount.tierOf(uint256(bal));
            if (t < minTier) minTier = t;
            if (minTier == 0) return 0;
            anyHit = true;
        }
        return anyHit ? minTier : 0;
    }

    // ─── T-087 Sub 2.A — projected tierExpirySec ─────────────────────

    /// @dev Forecasted EFFECTIVE_TIER expiry timestamp.
    ///
    ///      Architectural note (Codex Sub 2.A round-1 P1): under the
    ///      integrated design, this scan is INERT. The min-tier-over-
    ///      history clamp added later (Codex round-10 P1 #5) already
    ///      catches every decay scenario on Base — the user's
    ///      effective tier drops the same day a partial unstake's
    ///      `dayMin` enters the min-history window. Once the clamp
    ///      has dropped the effective tier, the projection under
    ///      "constant balance held forever" can never produce a
    ///      tier BELOW that value, because future days' projected
    ///      `dayMin = currentBalance` and the projected min-tier-
    ///      over-history equals the current min-tier-over-history.
    ///
    ///      So the scan would always return `type(uint40).max` for
    ///      every realistic input. Rather than burn ~900 SLOADs per
    ///      rollup computing a sentinel, write it directly.
    ///
    ///      The mirror cache's freshness is enforced by the OTHER
    ///      three gates wired in Sub 1.C
    ///      (`_mirrorEffectiveTierAndBps`):
    ///        - effective tier non-zero (push wrote a real value)
    ///        - `tierTableVersion` match (governance hasn't moved)
    ///        - `cfgMirrorTierMaxAgeSec` backstop (60-day default)
    ///      These three are load-bearing; the expiry field remains
    ///      a storage slot Sub 2.B will populate with the sentinel
    ///      on every CCIP push so the receive-side decode shape stays
    ///      stable. If a future design change reintroduces a scenario
    ///      the projection could meaningfully forecast, this helper
    ///      is the natural extension point.
    function _computeProjectedTierExpiry(
        LibVaipakam.Storage storage /* s */,
        address /* user */,
        uint16 /* today */,
        uint120 /* currentBalance */
    ) private pure returns (uint40) {
        return type(uint40).max;
    }
}
