// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {LibVaipakam} from "./LibVaipakam.sol";
import {LibSanctionedLock} from "./LibSanctionedLock.sol";
import {IVaipakamErrors} from "../interfaces/IVaipakamErrors.sol";

/**
 * @title  LibRewardSanctions
 * @author Vaipakam Developer Team
 * @notice #1566 — the ONE classifier that decides what happens to protocol
 *         interaction reward owed to a wallet the sanctions screen bars:
 *         DELIVER (not barred), HOLD (barred, flag not yet confirmed — the
 *         reward is withheld and nothing moves) or CONFIRMED (the flag is
 *         confirmed — the owner's reward may be settled: what it earned while
 *         flagged is forfeited, what it earned before is set apart for it).
 *         Owner rule 2026-10-14 (revising 2026-10-02's "forfeit everything
 *         undelivered"): after a wallet is flagged nothing is paid to it until
 *         the flag is revoked; reward earned WHILE it was flagged is forfeited
 *         into the recycle bucket; reward earned BEFORE is held apart and paid
 *         once the flag is revoked. Value already in its vault stays frozen;
 *         loan value is unchanged.
 *
 *         WHAT "EARNED WHILE FLAGGED" MEANS: a confirmed chain's WINDOW — the
 *         reward days from the day of its first Flagged observation through
 *         the day of its last ({chainWindow}). A stored chain is confirmed
 *         exactly when `lastSeenAt >= flaggedAt + CONFIRM_SECS`, because only
 *         the confirming observation (row 7) writes such a word, so a window is
 *         a property of the evidence alone. When a confirmed chain ends — a
 *         Clean read clears it, or a new chain restarts over it — its window is
 *         RECORDED ({_recordWindow}), so a day settled afterwards still
 *         forfeits ({dayForfeited}). A chain that ends unconfirmed forfeits
 *         nothing: one read, a vendor glitch or a listing lifted within the
 *         confirmation window costs the wallet nothing.
 *
 * @dev    WHY A CHAIN OF OBSERVATIONS, NOT ONE READ. A forfeit is
 *         irreversible, so it must never follow a single oracle answer — a
 *         false positive, a listing lifted within hours, or evidence left over
 *         from an earlier listing. CONFIRMED therefore means all four of:
 *           1. an authoritative Flagged read NOW;
 *           2. the #1123 `sanctionsConfirmedFlagged` marker set and not cleared
 *              since — every authoritative Clean self-heal in the codebase
 *              deletes it, so a delisting ANY path observed restarts the chain
 *              here at no cost;
 *           3. evidence THIS classifier wrote, against the SAME oracle address
 *              (re-pointing the oracle restarts the chain);
 *           4. Flagged observations chained with every gap at most
 *              {MAX_OBS_GAP_SECS} (G), spanning at least {CONFIRM_SECS} (W).
 *         Any gap longer than G — an unobserved delisting, an outage, a pause,
 *         an oracle unset and re-set — breaks the chain, so stale evidence can
 *         never combine with one later read into a forfeit.
 *
 *         THE ROWS (`oracle` = the configured oracle, `st` =
 *         {LibVaipakam.sanctionsStatus}, `marker` = the #1123 marker; a LIVE
 *         chain = conditions 2-4 short of the span):
 *           1. oracle unset, or `who == 0`   → Deliver; no write
 *           2. Clean                         → Deliver; marker and evidence cleared
 *           3. Unavailable, no marker        → Deliver; no write
 *           4. Unavailable, marker           → Hold;    no write (the gap grows)
 *           5. Flagged, no live chain        → Hold;    marker set, chain started at now
 *           6. Flagged, live chain, age < W  → Hold;    `lastSeenAt` = now
 *           7. Flagged, live chain, age >= W → Confirmed; `lastSeenAt` = now
 *         INVARIANT: Deliver <=> `!LibVaipakam.isRecipientBarred(who)`, row for
 *         row, BY CONSTRUCTION: the barred bit is read from
 *         {LibVaipakam.recipientBarredRead}, the one body of that predicate.
 *         This library only splits "barred" into Hold and Confirmed; it never
 *         re-decides it, so the claim gate, the expiry clock's pause and this
 *         classifier can never disagree about who is barred.
 *
 *         WHO OBSERVES: the owner settlement
 *         (`RewardClaimFacet.settleSanctionedInteractionRewards`), the
 *         permissionless evidence entry
 *         (`RewardHorizonSweepFacet.recordRewardSanctionsEvidence`, also the
 *         self-call target of {callObserve}), and a staged claim's last page
 *         (`LibRewardStaging._pay`, through {callObserve}). Every write follows
 *         an authoritative read, so no caller can forge a chain or break one.
 *
 *         ACCEPTED SAMPLING LIMIT: a delisting shorter than G that no
 *         observation sees can sit inside a confirmed chain — and so can one
 *         another path observed (clearing the marker) if a later Flagged read
 *         on some other path re-sets the marker before this classifier next
 *         observes, all within G. The same class as the reward-expiry
 *         heartbeat's; a denser observation cadence narrows it.
 */
library LibRewardSanctions {
    /// @notice The classifier's answer. Deliver = not barred; Hold = barred,
    ///         not yet confirmed (withhold, move nothing); Confirmed = barred
    ///         and confirmed (the owner's reward may be settled: window days
    ///         forfeit, the rest is set apart for the wallet).
    enum Decision {
        Deliver,
        Hold,
        Confirmed
    }

    /// @dev Which write {observe} makes for a row — the one hand-off between
    ///      the shared row logic ({_classify}) and the writer, so the rows are
    ///      stated once for the view and the observation alike.
    enum EvidenceWrite {
        None,
        Clear,
        Restart,
        Refresh
    }

    /// @notice W — how long a chain of Flagged observations must span before
    ///         a forfeit (owner decision O-1). Long enough that a listing
    ///         lifted within days, or a vendor glitch, never forfeits; short
    ///         enough that a held staging record (which keeps
    ///         `stagingEncumberedCount` raised) waits a bounded time.
    uint256 internal constant CONFIRM_SECS = 3 days;
    /// @notice G — the longest gap allowed between two observations of one
    ///         chain (owner decision O-1). Strictly positive and below
    ///         {CONFIRM_SECS}, so a confirmed chain holds at least three
    ///         observations and an outage, pause or oracle swap longer than a
    ///         day restarts the window. A keeper must observe a held wallet at
    ///         least this often for a chain to complete.
    uint256 internal constant MAX_OBS_GAP_SECS = 1 days;

    /// @dev The 48-bit field mask of the evidence word. A block timestamp needs
    ///      2^48 seconds (about 8.9 million years) to overflow it; masking keeps
    ///      one field from ever bleeding into the next all the same.
    uint256 private constant MASK48 = (uint256(1) << 48) - 1;

    /// @notice `who`'s confirmation chain (re)started: an authoritative Flagged
    ///         read found no live chain — the first flag, a gap over
    ///         {MAX_OBS_GAP_SECS}, another oracle, or a marker a Clean read had
    ///         cleared. Nothing moves now. The chain confirms at
    ///         `forfeitableAt` — from then, reward earned while flagged is
    ///         forfeitable — only if Flagged observations keep coming at most
    ///         {MAX_OBS_GAP_SECS} apart until then.
    /// @custom:event-category state-change/reward-claim
    event RewardSanctionsEvidenceRecorded(
        address indexed who,
        address indexed oracle,
        uint64 flaggedAt,
        uint64 forfeitableAt
    );
    /// @notice An authoritative Clean read deleted `who`'s chain (with the
    ///         #1123 marker): a later flag starts a new confirmation window.
    /// @custom:event-category state-change/reward-claim
    event RewardSanctionsEvidenceCleared(address indexed who);
    /// @notice A confirmed chain of `who` ended (cleared or restarted over) and
    ///         its window was recorded: reward `who` earned on the days
    ///         `fromDay..toDay` (inclusive) is forfeited whenever it settles.
    /// @custom:event-category state-change/reward-claim
    event RewardSanctionsWindowRecorded(address indexed who, uint256 fromDay, uint256 toDay);

    /// @notice A window's one codec: `fromDay(128) | toDay(128)`, high to low.
    function packWindow(uint256 fromDay, uint256 toDay) internal pure returns (uint256) {
        return (fromDay << 128) | uint128(toDay);
    }

    /// @notice Inverse of {packWindow}.
    function unpackWindow(uint256 w) internal pure returns (uint256 fromDay, uint256 toDay) {
        fromDay = w >> 128;
        toDay = uint128(w);
    }

    /// @notice The reward day a timestamp falls on — the day index every reward
    ///         record uses (`(ts - launch) / 1 days`); a time before the
    ///         interaction launch is day 0.
    function dayOf(LibVaipakam.Storage storage s, uint256 ts) internal view returns (uint256) {
        uint256 launch = s.interactionLaunchTimestamp;
        return launch == 0 || ts < launch ? 0 : (ts - launch) / 1 days;
    }

    /// @notice The window a stored chain defines, if it is confirmed: from the
    ///         day of its first Flagged observation through the day of its last.
    ///         Read from the evidence alone — liveness is not required, so a
    ///         confirmed chain that has since lapsed, or whose marker another
    ///         path cleared, still names the days it covered until an
    ///         observation records it.
    function chainWindow(LibVaipakam.Storage storage s, uint64 flaggedAt, uint64 lastSeenAt)
        internal
        view
        returns (bool confirmed, uint256 fromDay, uint256 toDay)
    {
        if (flaggedAt == 0 || uint256(lastSeenAt) < uint256(flaggedAt) + CONFIRM_SECS) return (false, 0, 0);
        return (true, dayOf(s, flaggedAt), dayOf(s, lastSeenAt));
    }

    /// @notice How many window SLOTS {windowAt} serves for `who`: every
    ///         recorded window plus one for the stored chain (which may or may
    ///         not be confirmed).
    function windowSlots(LibVaipakam.Storage storage s, address who) internal view returns (uint256) {
        return s.rewardSanctionsWindows[who].length + 1;
    }

    /// @notice Window slot `i` of `who`: a recorded window, or — the last slot
    ///         — the stored chain's window when it is confirmed (`ok == false`
    ///         otherwise). The ONE enumeration every per-day reader uses.
    function windowAt(LibVaipakam.Storage storage s, address who, uint256 i)
        internal
        view
        returns (bool ok, uint256 fromDay, uint256 toDay)
    {
        uint256[] storage recorded = s.rewardSanctionsWindows[who];
        if (i < recorded.length) {
            (fromDay, toDay) = unpackWindow(recorded[i]);
            return (true, fromDay, toDay);
        }
        (, uint64 flaggedAt, uint64 lastSeenAt) = unpackEvidence(s.rewardSanctionsEvidence[who]);
        return chainWindow(s, flaggedAt, lastSeenAt);
    }

    /// @notice Whether reward `who` earned on day `d` was earned while a
    ///         CONFIRMED flag stood — and so is forfeited, never delivered,
    ///         whenever and by whichever path it settles. THE predicate: the day
    ///         pricing's treasury routing, the legacy window and the staged
    ///         payout all read it.
    /// @dev    Two reads decide it for every wallet with no sanctions evidence
    ///         and no recorded window — all but a handful — and only those are
    ///         inlined into the reward walks, which sit at EIP-170. A wallet with
    ///         evidence takes the window loop ({dayForfeitedFull}) on its ONE
    ///         host, `RewardHorizonSweepFacet.rewardSanctionsDayForfeited`, by a
    ///         self-staticcall.
    function dayForfeited(LibVaipakam.Storage storage s, address who, uint256 d) internal view returns (bool) {
        if (!hasSanctionsHistory(s, who)) return false;
        (bool ok, bytes memory ret) =
            address(this).staticcall(abi.encodeWithSignature("rewardSanctionsDayForfeited(address,uint256)", who, d));
        // Fail CLOSED: an unrouted host on a partly refreshed Diamond, or a short
        // answer, refuses — the host is a plain view, so no reason is carried.
        if (!ok || ret.length < 32) revert IVaipakamErrors.RewardCustodyCallFailed();
        return abi.decode(ret, (bool));
    }

    /// @notice Whether `who` has any sanctions evidence or recorded window —
    ///         the fast path every per-day reader takes first.
    function hasSanctionsHistory(LibVaipakam.Storage storage s, address who) internal view returns (bool) {
        return s.rewardSanctionsEvidence[who] != 0 || s.rewardSanctionsWindows[who].length != 0;
    }

    /// @notice {dayForfeited}'s window loop — run on its host only.
    function dayForfeitedFull(LibVaipakam.Storage storage s, address who, uint256 d) internal view returns (bool) {
        uint256 n = windowSlots(s, who);
        for (uint256 i; i < n; ) {
            (bool ok, uint256 fromDay, uint256 toDay) = windowAt(s, who, i);
            if (ok && d >= fromDay && d <= toDay) return true;
            unchecked { ++i; }
        }
        return false;
    }

    /// @notice The evidence word's one codec:
    ///         `oracle(160) | flaggedAt(48) | lastSeenAt(48)`, high to low.
    function packEvidence(address oracle, uint64 flaggedAt, uint64 lastSeenAt) internal pure returns (uint256) {
        return (uint256(uint160(oracle)) << 96) | ((uint256(flaggedAt) & MASK48) << 48)
            | (uint256(lastSeenAt) & MASK48);
    }

    /// @notice Inverse of {packEvidence}; a zero word unpacks to all zeros
    ///         (no chain).
    function unpackEvidence(uint256 w) internal pure returns (address oracle, uint64 flaggedAt, uint64 lastSeenAt) {
        oracle = address(uint160(w >> 96));
        flaggedAt = uint64((w >> 48) & MASK48);
        lastSeenAt = uint64(w & MASK48);
    }

    /// @notice The classifier's answer for `who` NOW, writing nothing — the
    ///         same rows {observe} applies (one shared body, {_classify}).
    /// @dev    `flaggedAt` / `lastSeenAt` describe the LIVE chain as COMMITTED
    ///         — written here, against the configured oracle, its marker not
    ///         cleared since, its last observation at most {MAX_OBS_GAP_SECS}
    ///         ago — and are both ZERO when there is none (no evidence, a
    ///         broken or foreign chain, a Clean read that would clear it, or
    ///         row 5, where an observation now would START a chain). So
    ///         `flaggedAt + CONFIRM_SECS` is when a live chain can confirm and
    ///         `lastSeenAt + MAX_OBS_GAP_SECS` is the deadline for its next
    ///         observation. They never anticipate the `lastSeenAt` an
    ///         observation would write: that is what keeps the deadline
    ///         meaningful to a keeper.
    /// @param  s   Diamond storage.
    /// @param  who The wallet to classify.
    function decide(LibVaipakam.Storage storage s, address who)
        internal
        view
        returns (Decision d, uint64 flaggedAt, uint64 lastSeenAt)
    {
        (d, , , flaggedAt, lastSeenAt) = _classify(s, who);
    }

    /// @notice Classify `who` and commit the evidence its row calls for — the
    ///         ONE writer of `rewardSanctionsEvidence` (rows in the header).
    /// @dev    No revert of its own: the oracle reads are
    ///         {LibVaipakam.sanctionsStatus}'s try/catch reads (an oracle that
    ///         answers with undecodable data is the one exception, shared with
    ///         every caller of that read). A caller acting on the decision must
    ///         not revert on Hold — the evidence just committed would roll back
    ///         with it, and a chain could then never be built.
    /// @param  s   Diamond storage.
    /// @param  who The wallet to observe.
    function observe(LibVaipakam.Storage storage s, address who) internal returns (Decision d) {
        EvidenceWrite w;
        uint256 word;
        uint64 flaggedAt;
        (d, w, word, flaggedAt, ) = _classify(s, who);
        if (w == EvidenceWrite.Clear) {
            // Row 2 — the heal every authoritative Clean read performs on the
            // #1123 marker, plus this classifier's own chain. A confirmed
            // chain's window is recorded before the chain goes.
            LibSanctionedLock.clearConfirmedFlag(s, who);
            if (word != 0) {
                _recordWindow(s, who, word);
                delete s.rewardSanctionsEvidence[who];
                emit RewardSanctionsEvidenceCleared(who);
            }
        } else if (w == EvidenceWrite.Restart) {
            // Row 5 — commit the marker this authoritative read proves, and
            // start the chain at now under the configured oracle.
            address oracle = s.sanctionsOracle;
            uint64 nowTs = uint64(block.timestamp);
            // A confirmed chain this one replaces (lapsed, foreign-oracle, or
            // its marker cleared by another path) keeps its window.
            _recordWindow(s, who, word);
            s.sanctionsConfirmedFlagged[who] = true;
            s.rewardSanctionsEvidence[who] = packEvidence(oracle, nowTs, nowTs);
            emit RewardSanctionsEvidenceRecorded(who, oracle, nowTs, nowTs + uint64(CONFIRM_SECS));
        } else if (w == EvidenceWrite.Refresh) {
            // Rows 6-7 — the live chain's oracle IS the configured one, so the
            // repack changes `lastSeenAt` alone (skipped within one second).
            uint256 next = packEvidence(s.sanctionsOracle, flaggedAt, uint64(block.timestamp));
            if (next != word) s.rewardSanctionsEvidence[who] = next;
        }
    }

    /// @notice {observe} for `who`, reached through the Diamond on its ONE
    ///         host, `RewardHorizonSweepFacet.recordRewardSanctionsEvidence`,
    ///         by self-call — the shape of the reward walks' stubs
    ///         ({LibInteractionRewards.callSweepExpiredEntryWalk}).
    /// @dev    WHY a self-call: the staged payout's last page
    ///         (`LibRewardStaging._pay`, on `RewardStagingSettleFacet`) must make an
    ///         observation that
    ///         COMMITS — a view could neither start nor extend a chain — and
    ///         the classifier's oracle reads, writes and events are hosted ONCE,
    ///         on the evidence host, not inlined into the settle facet (which
    ///         sat a few hundred bytes under EIP-170 when this seam was cut).
    ///         The host carries no reentrancy guard (it moves no value;
    ///         its only external calls are the oracle STATICCALLs), so the
    ///         page's held Diamond guard does not refuse it.
    ///
    ///         A failure re-raises the host's revert data unchanged, so a page
    ///         whose host is missing (the settle facet refreshed without the
    ///         sweep facet) reverts rather than paying past the screen; a
    ///         failure without data raises
    ///         {IVaipakamErrors.RewardCustodyCallFailed}. The answer is the
    ///         host's `uint8`, converted to {Decision}: a value outside the
    ///         enum fails that conversion (Panic 0x21) rather than being
    ///         guessed at, since neither paying nor forfeiting on an answer
    ///         this library cannot read is safe.
    /// @param  who The claimant to observe.
    /// @return The classifier's decision, as the host's observation wrote it.
    function callObserve(address who) internal returns (Decision) {
        (bool ok, bytes memory ret) = address(this).call(
            abi.encodeWithSignature("recordRewardSanctionsEvidence(address)", who)
        );
        if (!ok) {
            if (ret.length == 0) revert IVaipakamErrors.RewardCustodyCallFailed();
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return Decision(abi.decode(ret, (uint8)));
    }

    /// @dev The rows, ONCE, for {decide} and {observe}. `word` is the stored
    ///      evidence (a Clear deletes it when non-zero; a Refresh rewrites its
    ///      `lastSeenAt`); `flaggedAt` / `lastSeenAt` are the live chain's
    ///      committed figures, zero without one ({decide}'s contract).
    function _classify(LibVaipakam.Storage storage s, address who)
        private
        view
        returns (Decision d, EvidenceWrite w, uint256 word, uint64 flaggedAt, uint64 lastSeenAt)
    {
        (bool barred, LibVaipakam.SanctionsRead st) = LibVaipakam.recipientBarredRead(who);
        word = s.rewardSanctionsEvidence[who];
        // Row 2: an authoritative Clean read heals — the chain and the marker go.
        if (st == LibVaipakam.SanctionsRead.Clean) return (Decision.Deliver, EvidenceWrite.Clear, word, 0, 0);
        address evOracle;
        (evOracle, flaggedAt, lastSeenAt) = unpackEvidence(word);
        // A LIVE chain: written here, under the configured oracle, last seen
        // within G, its marker not cleared since by any Clean read.
        if (
            flaggedAt == 0 || evOracle != s.sanctionsOracle
                || block.timestamp > uint256(lastSeenAt) + MAX_OBS_GAP_SECS || !s.sanctionsConfirmedFlagged[who]
        ) {
            flaggedAt = 0;
            lastSeenAt = 0;
        }
        // Rows 1 and 3: not barred (oracle unset, `who == 0`, or an outage
        // over no committed flag) — deliver, write nothing.
        if (!barred) return (Decision.Deliver, EvidenceWrite.None, word, flaggedAt, lastSeenAt);
        // Row 4: barred by the committed marker during an outage — withhold.
        // There is no read to record, so the gap simply grows.
        if (st != LibVaipakam.SanctionsRead.Flagged) {
            return (Decision.Hold, EvidenceWrite.None, word, flaggedAt, lastSeenAt);
        }
        // Row 5: Flagged with no live chain — start one; one read never forfeits.
        if (flaggedAt == 0) return (Decision.Hold, EvidenceWrite.Restart, word, 0, 0);
        // Rows 6 and 7: the chain continues, and confirms once it spans W.
        d = block.timestamp < uint256(flaggedAt) + CONFIRM_SECS ? Decision.Hold : Decision.Confirmed;
        return (d, EvidenceWrite.Refresh, word, flaggedAt, lastSeenAt);
    }

    /// @dev Record the window of the stored chain `word` if it is confirmed —
    ///      called ONLY where a chain ends (a Clear deletes it, a Restart
    ///      overwrites it), so each confirmed chain is recorded exactly once.
    ///      An unconfirmed chain records nothing: it forfeits nothing.
    function _recordWindow(LibVaipakam.Storage storage s, address who, uint256 word) private {
        if (word == 0) return;
        (, uint64 flaggedAt, uint64 lastSeenAt) = unpackEvidence(word);
        (bool confirmed, uint256 fromDay, uint256 toDay) = chainWindow(s, flaggedAt, lastSeenAt);
        if (!confirmed) return;
        s.rewardSanctionsWindows[who].push(packWindow(fromDay, toDay));
        emit RewardSanctionsWindowRecorded(who, fromDay, toDay);
    }
}
