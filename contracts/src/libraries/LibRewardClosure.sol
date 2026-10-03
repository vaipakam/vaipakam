// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibInteractionRewards} from "./LibInteractionRewards.sol";
import {LibRewardCustody} from "./LibRewardCustody.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title LibRewardClosure
/// @notice 3b-ii-B — the per-day CLOSURE PROOF (#1566 design §"3b-ii-B", mechanism (v)):
///         a permissionless, resumable walk with the SAME shape as the mirror's
///         commitment accumulation — ascending entry ids, a per-side cursor, the
///         cover check, completeness by conservation against the folded side
///         totals — where every visited entry must have TERMINATED, completing in
///         `dayObligationsClosed[day]`. Zero cost on any settlement path; paid once
///         per day, ever, by whoever wants a batch listing it closed.
///
///         Two conditions, because the stamp is irreversible (Codex #2274 r1/r2):
///         admissible only after the chain's OWN day close (the side totals the
///         completeness test compares against are final only once the day is
///         folded and reported) AND only once both interest frontiers have reached
///         the day (#2277 — the close stamp alone was not that guarantee; an EMPTY
///         walk would otherwise pass conservation against two zero totals).
///
///         A walk is the STARTER's, keyed (day, starter, nonce), never a shared
///         per-day cursor: a caller who omits a covering id advances only their own
///         cursor past it, so their walk can never complete and is abandoned; a
///         fresh nonce starts another, and the day is stamped by the first walk to
///         complete. No reset entry, no administrator in the loop.
library LibRewardClosure {
    /// @notice A closure walk opened for `day` by `starter` under `nonce`.
    /// @custom:event-category state-change/reward-closure
    event ClosureWalkStarted(uint256 indexed day, address indexed starter, uint64 nonce, bytes32 key);
    /// @notice A page of the walk advanced one side to `cursor` with conservation `sum`.
    /// @custom:event-category state-change/reward-closure
    event ClosureWalkAdvanced(bytes32 indexed key, uint8 side, uint256 cursor, uint256 sum, bool sideComplete);
    /// @notice Every obligation covering `day` has terminated: the day is proven closed, once, for ever.
    /// @custom:event-category state-change/reward-closure
    event DayObligationsClosed(uint256 indexed day, address indexed starter, uint64 nonce);

    function walkKey(uint256 day, address starter, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode("closure-walk", day, starter, nonce));
    }

    /// @dev The two conditions above plus "elapsed" and "not yet closed"; reverts by name.
    function requireAdmissible(LibVaipakam.Storage storage s, uint256 day) internal view {
        (uint256 today, bool active) = LibInteractionRewards.currentDayOrZero();
        if (!active || day >= today) revert IVaipakamErrors.ClosureDayNotElapsed(day);
        if (s.dayObligationsClosed[day]) revert IVaipakamErrors.ClosureDayAlreadyClosed(day);
        if (s.chainReportSentAt[day] == 0) revert IVaipakamErrors.ClosureDayNotLocallyClosed(day);
        if (s.lenderFrontierDay < day || s.borrowerFrontierDay < day) {
            revert IVaipakamErrors.ClosureFrontierShort(day, s.lenderFrontierDay, s.borrowerFrontierDay);
        }
    }

    /// @notice Open a walk for `day` under the caller's next nonce. A side whose folded
    ///         total is zero has nothing to visit and is complete at once; a day with
    ///         both totals zero closes here (admissible only with the fold at the day,
    ///         which is exactly what rules out the empty-walk hole).
    function start(LibVaipakam.Storage storage s, uint256 day, address starter)
        internal
        returns (bytes32 key, uint64 nonce, bool dayClosed)
    {
        requireAdmissible(s, day);
        nonce = ++s.closureWalkNonce[starter];
        key = walkKey(day, starter, nonce);
        LibVaipakam.ClosureWalk storage w = s.closureWalks[key];
        w.starter = starter;
        w.day = SafeCast.toUint64(day);
        w.nonce = nonce;
        w.lenderComplete = s.totalLenderInterestNumeraire18[day] == 0;
        w.borrowerComplete = s.totalBorrowerInterestNumeraire18[day] == 0;
        emit ClosureWalkStarted(day, starter, nonce, key);
        dayClosed = _tryComplete(s, w, key);
    }

    /// @notice One page of the starter's walk: `entryIds` ascending past the side's
    ///         cursor, each of this side and covering the day, each TERMINATED on it;
    ///         the side's conservation grows by their per-day figures and the side is
    ///         complete when it equals the day's folded total. Reverts name the first
    ///         offending entry and leave the page unapplied (earlier pages stand).
    function provePage(
        LibVaipakam.Storage storage s,
        uint256 day,
        address starter,
        uint64 nonce,
        LibVaipakam.RewardSide side,
        uint256[] calldata entryIds
    ) internal returns (bool dayClosed) {
        bytes32 key = walkKey(day, starter, nonce);
        LibVaipakam.ClosureWalk storage w = s.closureWalks[key];
        if (w.starter == address(0)) revert IVaipakamErrors.ClosureWalkUnknown(key);
        requireAdmissible(s, day);
        bool lender = side == LibVaipakam.RewardSide.Lender;
        uint256 cursor = lender ? w.lenderCursor : w.borrowerCursor;
        uint256 sum = lender ? w.lenderConservation : w.borrowerConservation;
        uint256 total = lender ? s.totalLenderInterestNumeraire18[day] : s.totalBorrowerInterestNumeraire18[day];
        uint256 n = entryIds.length;
        for (uint256 i; i < n; ) {
            uint256 id = entryIds[i];
            if (id <= cursor) revert IVaipakamErrors.ClosureEntriesNotAscending(id);
            cursor = id;
            LibVaipakam.RewardEntry storage e = s.rewardEntries[id];
            uint256 first = e.startDay == 0 ? 1 : e.startDay; // the accumulation's reading, kept
            if (e.side != side || day < first || day >= e.endDay) {
                revert IVaipakamErrors.ClosureEntryNotCovering(day, id);
            }
            if (!entryTerminatedOn(s, id, e, day)) revert IVaipakamErrors.ClosureEntryOpen(day, id);
            sum += e.perDayNumeraire18;
            unchecked { ++i; }
        }
        if (sum > total) revert IVaipakamErrors.ClosureConservationExceeded(day, uint8(side), sum, total);
        bool complete = sum == total;
        if (lender) {
            w.lenderCursor = cursor;
            w.lenderConservation = sum;
            w.lenderComplete = complete;
        } else {
            w.borrowerCursor = cursor;
            w.borrowerConservation = sum;
            w.borrowerComplete = complete;
        }
        emit ClosureWalkAdvanced(key, uint8(side), cursor, sum, complete);
        dayClosed = _tryComplete(s, w, key);
    }

    /// @notice Whether entry `id` has TERMINATED on `day` (design fact 4, plus what A2
    ///         and A2-ii (c) added): settled or swept whole (`processed`), or part-claimed
    ///         with the claim cursor past the day; and no staging record of the
    ///         claimant-side stands on the day (a staged day is not closed — A2), and no
    ///         legacy-slice domain of the entry is open over a window covering it (A2-ii (c)).
    function entryTerminatedOn(
        LibVaipakam.Storage storage s,
        uint256 id,
        LibVaipakam.RewardEntry storage e,
        uint256 day
    ) internal view returns (bool) {
        if (!e.processed && s.rewardEntryClaimNextDay[id] <= day) return false;
        if (s.stagingRecords[LibRewardCustody.stagingKey(e.user, e.side, day)].phase != LibVaipakam.StagingPhase.None) {
            return false;
        }
        LibVaipakam.StagingDomain storage dom = s.stagingDomains[LibRewardCustody.legacyDomainKey(id)];
        if (
            dom.phase == LibVaipakam.DomainPhase.Staging && dom.legacy && dom.firstDay <= day && day <= dom.lastDay
        ) {
            return false;
        }
        return true;
    }

    function _tryComplete(LibVaipakam.Storage storage s, LibVaipakam.ClosureWalk storage w, bytes32 key)
        private
        returns (bool)
    {
        if (!(w.lenderComplete && w.borrowerComplete)) return false;
        w.completed = true;
        s.dayObligationsClosed[w.day] = true;
        emit DayObligationsClosed(w.day, w.starter, w.nonce);
        key; // the walk is reachable by its key; nothing else to record
        return true;
    }
}
