// src/libraries/LibRewardDayReport.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";

/**
 * @title  LibRewardDayReport
 * @author Vaipakam Developer Team
 * @notice #2618 / #2613 — the one place on `Base` that records a chain's day
 *         report as received and judges whether a day is ready to finalize.
 *
 * @dev    Two questions used to share one check, and must not:
 *
 *           - WHO MAY REPORT. Any chain the reward messenger authenticates.
 *             A report says two kinds of thing: the day's own figures, and
 *             what it says about the CHAIN (custody era, recycled
 *             availability, commitment retirement and release — one-way
 *             ratchets clamped against `Base`'s own records). The chain-wide
 *             figures always apply. Refusing an off-list chain's report used
 *             to throw them away, which left a detached chain's retired
 *             commitments outstanding for good.
 *           - WHOSE DAY FIGURES COUNT. Only the chains on the expected-source
 *             list at finalization: `_finalizeAndWrite` sums exactly those.
 *             An off-list chain's day figures are stored and announced as not
 *             counted; if the chain is listed again before the day finalizes,
 *             they count, with no manual re-execution of a refused message.
 *
 *         So the list decides topology alone, and this library applies it the
 *         same way everywhere: coverage is judged chain by chain over the
 *         list (never by a report count, which an off-list report would
 *         inflate), only a listed chain's report starts the grace window, and
 *         a permissionless finalization refuses a list that is empty or leaves
 *         `Base` out, since either would zero real interest irreversibly. The
 *         admin `forceFinalizeDay` override is not judged here.
 *
 *         `internal`, so it inlines into the aggregator (mirror reports) and
 *         the reporter (Base's own report).
 */
library LibRewardDayReport {
    /// @notice A report from a chain not on the expected-source list was
    ///         stored. Its day figures count only if the chain is listed when
    ///         `dayId` finalizes; what it says about the chain already applied.
    event ChainReportStoredOffList(uint32 indexed sourceChainId, uint256 indexed dayId);

    /// @dev `isDayReadyToFinalize` reasons. Zero means ready.
    uint8 internal constant READY = 0;
    uint8 internal constant FINALIZED = 1;
    uint8 internal constant NO_LISTED_REPORT = 2;
    uint8 internal constant WAITING = 3;
    uint8 internal constant LIST_UNUSABLE = 4;

    /// @dev The default grace window, in step with both facets' constant.
    uint64 internal constant DEFAULT_REWARD_GRACE_SECONDS = 4 hours;

    /// @notice Whether `chainId` is on the expected-source list. The list is
    ///         tiny (one entry per Phase-1 chain), so a scan is cheaper than a
    ///         set kept in step with it.
    function isExpectedSource(LibVaipakam.Storage storage s, uint32 chainId) internal view returns (bool) {
        uint32[] storage list = s.expectedSourceChainIds;
        for (uint256 i; i < list.length; ) {
            if (list[i] == chainId) return true;
            unchecked {
                ++i;
            }
        }
        return false;
    }

    /// @notice Record that `sourceChainId` reported `dayId`. Called once per
    ///         (day, chain) after its figures are stored. Only a listed
    ///         chain's report starts the grace window; an off-list one is
    ///         announced as stored and not counted.
    function markReported(LibVaipakam.Storage storage s, uint256 dayId, uint32 sourceChainId)
        internal
        returns (uint32 count)
    {
        if (!s.chainDailyReported[dayId][sourceChainId]) {
            s.chainDailyReported[dayId][sourceChainId] = true;
            unchecked {
                s.chainDailyReportCount[dayId] += 1;
            }
        }
        count = s.chainDailyReportCount[dayId];
        if (isExpectedSource(s, sourceChainId)) {
            if (s.dailyFirstReportAt[dayId] == 0) s.dailyFirstReportAt[dayId] = uint64(block.timestamp);
        } else {
            emit ChainReportStoredOffList(sourceChainId, dayId);
        }
    }

    /// @notice Whether a permissionless finalization of `dayId` may run now,
    ///         and if not, why (see the reason constants).
    function readiness(LibVaipakam.Storage storage s, uint256 dayId) internal view returns (bool ready, uint8 reason) {
        if (s.dailyGlobalFinalized[dayId]) return (false, FINALIZED);
        uint32[] storage list = s.expectedSourceChainIds;
        uint256 n = list.length;
        // An empty list finalizes every day as zero; one without `Base`
        // leaves `Base`'s own interest out of the total. Both are for good.
        if (n == 0 || !isExpectedSource(s, uint32(block.chainid))) return (false, LIST_UNUSABLE);
        bool covered = true;
        for (uint256 i; i < n; ) {
            if (!s.chainDailyReported[dayId][list[i]]) {
                covered = false;
                break;
            }
            unchecked {
                ++i;
            }
        }
        if (covered) return (true, READY);
        uint64 firstAt = s.dailyFirstReportAt[dayId];
        if (firstAt == 0) return (false, NO_LISTED_REPORT);
        uint64 grace = s.rewardGraceSeconds == 0 ? DEFAULT_REWARD_GRACE_SECONDS : s.rewardGraceSeconds;
        if (block.timestamp >= uint256(firstAt) + uint256(grace)) return (true, READY);
        return (false, WAITING);
    }
}
