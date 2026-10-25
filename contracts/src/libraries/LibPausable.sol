// src/libraries/LibPausable.sol
// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.29;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title LibPausable
 * @notice Diamond-safe pausable mechanism using ERC-7201 namespaced storage.
 * @dev Replaces OpenZeppelin's Pausable inheritance which uses regular storage
 *      slots that collide across facets in a diamond proxy.
 */
library LibPausable {
    /// @dev ERC-7201 namespaced storage slot.
    ///      keccak256(abi.encode(uint256(keccak256("vaipakam.storage.Pausable")) - 1)) & ~bytes32(uint256(0xff))
    /// @dev `internal` rather than `private` (#1566 slice 4 PR A, Codex #2158
    ///      r26): the deploy tooling reads this ONE slot — raw, before a
    ///      refresh has routed any newer getter — to learn the manual flag
    ///      and the pause epoch, and {decodePausableSlot} is the single
    ///      decoder of its layout.
    bytes32 internal constant PAUSABLE_STORAGE_POSITION =
        0x2160e84a745d8897ad2778886d40d3563c8bc30c059c5f2173e21e9d47057400;

    /// @dev APPEND-ONLY POST-LAUNCH. New fields go at the end; never reorder,
    ///      rename, or change types of existing fields on live diamonds.
    struct PausableStorage {
        bool paused;
        // Auto-pause time window (Phase 1 follow-up). When non-zero,
        // the protocol is paused until `block.timestamp >=
        // pausedUntilTimestamp` regardless of the manual `paused` bool.
        // Zero ⇒ no auto-pause active. Set by
        // `AdminFacet.autoPause(...)` (WATCHER_ROLE-gated). Cleared
        // by:
        //   - normal expiry (block.timestamp catches up — handled in
        //     `requireNotPaused` so no unpause tx is needed)
        //   - admin's `unpause()` (short-circuit when verified
        //     false-positive)
        uint64 pausedUntilTimestamp;
        // Block-timestamp at which the pause STATE last changed — stamped by
        // `pause()`, `unpause()`, and `autoPause()`. Consumers that credit
        // "elapsed time the protocol was live" (e.g. the interaction-reward
        // claim-horizon accumulator) read this to DISCARD any observation
        // interval that straddled a pause: an interval whose prior sample
        // predates this boundary spanned a pause window during which every
        // gated action would have reverted, so it must not count as
        // executable time. Zero ⇒ the pause state has never changed.
        uint64 lastPauseBoundaryAt;
        // #1566 slice 4 PR A (Codex #2158 r27 P1) — a strictly monotonic count
        // of pause-state transitions: every `pause()`, every `unpause()` that
        // clears an active pause, every `autoPause()` that sets a window.
        // The pause EPOCH a one-shot migration is bound to: an answer
        // established under the manual pause at epoch N is only consumed
        // while the epoch is still N, so a lift-and-reapply in between —
        // even within one block, which a second-resolution timestamp cannot
        // tell apart — refuses it. Packs into this same slot (bytes 17..24).
        uint64 pauseTransitions;
        // #945 (Codex #2686 r6 P1) — who first lifted a pause, and when: the
        // Diamond's first moment live. A Diamond is born paused, so this is
        // its launch; any later pause is an incident, never a second launch.
        // Written once, by the first {unpause} that clears an active pause,
        // and never changed after, so the launch tooling reads the launch
        // from the Diamond itself rather than reconstructing it from the
        // Timelock operation it expects (which a changed LaunchGate build or
        // an inflated pause epoch would hide). Zero `firstUnpausedBy` means
        // it has never been live. Next slot: the address in bytes 0..19,
        // the timestamp in bytes 20..27.
        address firstUnpausedBy;
        uint64 firstUnpausedAt;
        // #945 (Codex #2686 r9 P1) — the launch gate the first unpause went
        // through, or zero when it went through a plain {unpause}. Written
        // only by {unpauseThroughGate}, in the same write as the two fields
        // above, so the record says not only who admitted users but whether
        // a readiness gate had just vouched for this Diamond in that call:
        // a bare Timelock unpause leaves `firstUnpausedBy` = the Timelock
        // and this zero, and the production launch tooling refuses it. Own
        // slot (slot + 2).
        address firstUnpausedVia;
        // #668 / #935 (owner decision D2) — every interval the protocol was
        // paused, oldest first, so a loan's deadlines can be moved by the
        // paused time since it started (`LibLoanClock`). Append-only: an
        // entry is only ever added, or its `end` written once. See
        // {PauseInterval} and docs/DesignsAndPlans/GlobalPauseD2Design.md.
        PauseInterval[] pauseIntervals;
        // #2744 — the end of the last auto-pause window that froze a live
        // protocol. The next such window may open only `autoPauseCooldownSeconds`
        // after it, so a watcher key cannot chain windows back to back into
        // an indefinite freeze (every paused second also moves every open
        // loan's deadlines, #668 / #935). Never cleared: an unpause that cuts
        // a window short leaves the cooldown running from the window's
        // scheduled end. A window recorded under the manual pause does not
        // write it (it froze nothing the manual pause had not already).
        uint64 lastAutoPauseUntil;
        // #2744 — the cooldown above, in seconds. Zero means
        // {AUTO_PAUSE_COOLDOWN_DEFAULT}. Set by the admin role (the Timelock
        // after handover), inside [{MIN_AUTO_PAUSE_COOLDOWN},
        // {MAX_AUTO_PAUSE_COOLDOWN}].
        uint32 autoPauseCooldownSeconds;
    }

    /// @dev #2744 — the default gap between the end of one auto-pause window
    ///      that froze a live protocol and the start of the next: 24 hours.
    ///      With the 2-hour window ceiling, a watcher key on its own can keep
    ///      the protocol frozen at most 2 hours in every 26 until its role is
    ///      revoked; a longer freeze needs the manual pause, which only the
    ///      pauser can set and only the unpauser (the Timelock) can lift.
    uint256 internal constant AUTO_PAUSE_COOLDOWN_DEFAULT = 24 hours;
    /// @dev The cooldown's floor. Not zero, so the setter cannot switch the
    ///      cooldown off.
    uint256 internal constant MIN_AUTO_PAUSE_COOLDOWN = 1 hours;
    /// @dev The cooldown's ceiling.
    uint256 internal constant MAX_AUTO_PAUSE_COOLDOWN = 7 days;

    /// @notice One paused interval.
    /// @dev `end == OPEN_END` while a manual pause is in force. An
    ///      auto-pause interval is written closed, with the window's own end,
    ///      and ends by itself. `pausedBefore` is the total paused time of
    ///      every earlier interval, so the total at any instant is one binary
    ///      search away. Intervals never overlap and are sorted by `start`.
    struct PauseInterval {
        uint64 start;
        uint64 end;
        uint64 pausedBefore;
    }

    /// @dev Marks an interval that is still open (a manual pause in force).
    uint64 internal constant OPEN_END = type(uint64).max;

    /// @custom:event-category informational/admin
    event Paused(address account);
    /// @custom:event-category informational/admin
    event Unpaused(address account);
    /// @dev Emitted when the watcher fires an auto-pause. `until` is the
    ///      block-timestamp at which the auto-pause window expires;
    ///      indexers + alerting use this to render countdown + correlate
    ///      with the off-chain anomaly that triggered.
    /// @custom:event-category informational/admin
    event AutoPaused(address indexed watcher, string reason, uint64 until);
    /// @notice A paused interval was closed by an unpause (#668 / #935).
    /// @dev    `pausedTotal` is the protocol's total paused time once this
    ///         interval is counted. Every open loan's deadlines move by the
    ///         part of the interval after the loan's start. An auto-pause
    ///         interval that lapses by itself emits no event of its own; its
    ///         end is the `until` of its {AutoPaused}.
    /// @custom:event-category informational/admin
    event PauseIntervalClosed(uint64 start, uint64 end, uint64 pausedTotal);
    /// @notice The cooldown between auto-pause windows was set (#2744).
    ///         `newSeconds == 0` restores the default.
    /// @custom:event-category informational/config
    event AutoPauseCooldownSet(uint32 newSeconds);

    error EnforcedPause();
    error ExpectedPause();
    /// @dev The manual pause was required and only an auto-pause window (or
    ///      nothing) is active.
    error ExpectedManualPause();
    /// @dev {pauseIntervalAt} was asked for an interval past the log.
    error PauseIntervalOutOfRange(uint256 index);
    /// @dev #2744 — an auto-pause would freeze a live protocol before the
    ///      cooldown since the last such window has run. `availableAt` is the
    ///      first timestamp at which it may.
    error AutoPauseCoolingDown(uint64 availableAt);
    /// @dev #2744 — a cooldown outside [`minSec`, `maxSec`] (0 is allowed:
    ///      it restores the default).
    error InvalidAutoPauseCooldown(uint32 provided, uint256 minSec, uint256 maxSec);

    function _storage() private pure returns (PausableStorage storage ps) {
        bytes32 position = PAUSABLE_STORAGE_POSITION;
        assembly {
            ps.slot := position
        }
    }

    /// @dev True iff the protocol is currently paused — either via the
    ///      manual `paused` bool (admin pause, indefinite) OR via an
    ///      active auto-pause window (`pausedUntilTimestamp > now`).
    ///      Auto-pause windows that have elapsed return false here so
    ///      no explicit unpause tx is needed once the window expires.
    function paused() internal view returns (bool) {
        PausableStorage storage ps = _storage();
        if (ps.paused) return true;
        return ps.pausedUntilTimestamp > block.timestamp;
    }

    function requireNotPaused() internal view {
        PausableStorage storage ps = _storage();
        if (ps.paused) revert EnforcedPause();
        if (ps.pausedUntilTimestamp > block.timestamp) revert EnforcedPause();
    }

    function requirePaused() internal view {
        if (!paused()) revert ExpectedPause();
    }

    /// @dev The manual flag alone — TRUE while `pause()` is in force, whether
    ///      or not an auto-pause window is active beside it (`pause()` leaves
    ///      an active window's timestamp intact, so `pausedUntil() == 0` is
    ///      NOT a valid proxy for this, Codex #2158 r26 P2).
    function manuallyPaused() internal view returns (bool) {
        return _storage().paused;
    }

    /// @dev The pause epoch: the strictly monotonic transition count.
    function pauseTransitions() internal view returns (uint64) {
        return _storage().pauseTransitions;
    }

    /// @dev Decode the raw first slot of {PausableStorage} — the four fields
    ///      pack into it: `paused` at byte 0, `pausedUntilTimestamp` in the
    ///      next 8 bytes, `lastPauseBoundaryAt` in the 8 after that, and
    ///      `pauseTransitions` in the 8 after those. The ONE implementation
    ///      of that layout for every reader that must see the pause state
    ///      before a refresh has routed the getters (the deploy scripts via
    ///      `vm.load`); the orchestrator's shell mirror of it is pinned to
    ///      this function by test.
    function decodePausableSlot(bytes32 raw)
        internal
        pure
        returns (bool manual, uint64 pausedUntilTimestamp, uint64 lastBoundaryAt, uint64 transitions)
    {
        uint256 word = uint256(raw);
        manual = uint8(word) != 0;
        pausedUntilTimestamp = uint64(word >> 8);
        lastBoundaryAt = uint64(word >> 72);
        transitions = uint64(word >> 136);
    }

    /// @dev The raw slot after the first: the first-unpause record.
    bytes32 internal constant FIRST_UNPAUSE_SLOT = bytes32(uint256(PAUSABLE_STORAGE_POSITION) + 1);

    /// @dev Decode the raw {FIRST_UNPAUSE_SLOT} — the ONE implementation of
    ///      that layout for the deploy scripts, which read it with `vm.load`
    ///      as they read the epoch. Zero `by` means never live.
    function decodeFirstUnpauseSlot(bytes32 raw) internal pure returns (address by, uint64 at) {
        uint256 word = uint256(raw);
        by = address(uint160(word));
        at = uint64(word >> 160);
    }

    /// @dev The raw slot holding {PausableStorage.firstUnpausedVia}: the
    ///      address in its low 20 bytes.
    bytes32 internal constant FIRST_UNPAUSE_VIA_SLOT = bytes32(uint256(PAUSABLE_STORAGE_POSITION) + 2);

    /// @dev Whether the Diamond has ever been live (a first unpause is on record).
    function everUnpaused() internal view returns (bool) {
        return _storage().firstUnpausedBy != address(0);
    }

    /// @dev The MANUAL pause only — an auto-pause window does not qualify.
    ///      For a ceremony or migration whose safety depends on service NOT
    ///      resuming until someone decides it should (#1566 slice 4 PR A,
    ///      Codex #2158 r18 P2): an auto-pause window lapses on its own, so a
    ///      step run under it alone would be followed by service resuming by
    ///      no one's decision — the opposite of the fresh Unpauser decision
    ///      the ceremony's design requires.
    function requireManuallyPaused() internal view {
        if (!manuallyPaused()) revert ExpectedManualPause();
    }

    function pause() internal {
        PausableStorage storage ps = _storage();
        _recordUnlogged(ps);
        _openInterval(ps);
        ps.paused = true;
        ps.lastPauseBoundaryAt = SafeCast.toUint64(block.timestamp);
        ++ps.pauseTransitions;
        emit Paused(msg.sender);
    }

    function unpause() internal {
        _unpause(address(0));
    }

    /// @dev {unpause}, recording `gate` as the launch gate when this is the
    ///      first unpause. The caller ({AdminFacet.launch}) has just had
    ///      `gate` vouch for this Diamond.
    function unpauseThroughGate(address gate) internal {
        _unpause(gate);
    }

    function _unpause(address via) private {
        // Clear both manual + auto-pause — admin can short-circuit a
        // false-positive auto-pause without waiting for the window
        // to elapse.
        PausableStorage storage ps = _storage();
        // A pause boundary is a real live→paused→live transition, so stamp it
        // ONLY when this call actually clears an active pause (manual, or an
        // auto-pause window still in the future). A no-op / cleanup unpause —
        // already live, or clearing an already-elapsed window — blocked no
        // claim, and stamping it would spuriously drop up to a heartbeat of
        // executable accrual for every RL-3-stamped entry (Codex #1317 r3 P3).
        bool wasPaused = ps.paused || ps.pausedUntilTimestamp > block.timestamp;
        // Clearing the flags below erases what {_unlogged} reads, so an
        // unlogged pause (even a lapsed window) reaches the log first.
        _recordUnlogged(ps);
        if (wasPaused) _closeInterval(ps);
        ps.paused = false;
        ps.pausedUntilTimestamp = 0;
        if (wasPaused) {
            ps.lastPauseBoundaryAt = SafeCast.toUint64(block.timestamp);
            ++ps.pauseTransitions;
            if (ps.firstUnpausedBy == address(0)) {
                ps.firstUnpausedBy = msg.sender;
                ps.firstUnpausedAt = SafeCast.toUint64(block.timestamp);
                ps.firstUnpausedVia = via;
            }
        }
        emit Unpaused(msg.sender);
    }

    /// @dev Phase 1 follow-up — auto-pause primitive. Sets a time-
    ///      bounded pause window. An ACTIVE window is never extended, and a
    ///      window that would freeze a live protocol may open only after the
    ///      cooldown since the end of the last such window (#2744), so a
    ///      compromised watcher can't chain calls into an indefinite freeze:
    ///      the most it can do is one window per cooldown, each of which
    ///      auto-clears at `now + duration`. A call refused by the cooldown
    ///      reverts {AutoPauseCoolingDown} rather than returning quietly, so
    ///      the watcher learns the protocol was NOT paused.
    ///
    ///      A watcher firing while the MANUAL pause is in force is NOT a
    ///      no-op any more (#1566 slice 4 PR A, Codex #2158 post-cap P1): it
    ///      records its window, counts a transition and emits the event,
    ///      exactly as it would on a live chain. The manual pause still
    ///      dominates while it lasts, and `unpause()` still clears both —
    ///      but the incident leaves a trace, so a scripted restore of
    ///      service that conditions on the transition count
    ///      (`AdminFacet.unpauseIfPauseEpoch`) refuses instead of reopening
    ///      service over an incident it never saw. Quietly returning on an
    ///      active window rather than reverting keeps a watcher racing an
    ///      admin's pause out of the watcher's error logs.
    function autoPause(uint256 duration, string memory reason) internal {
        PausableStorage storage ps = _storage();
        if (ps.pausedUntilTimestamp > block.timestamp) return;
        uint64 until = SafeCast.toUint64(block.timestamp + duration);
        // #2744 — a window that would freeze a live protocol waits out the
        // cooldown since the last one, and starts the next cooldown. Under
        // the manual pause the window freezes nothing more, so it neither
        // waits nor starts one: the incident still leaves its trace below.
        if (!ps.paused) {
            uint64 availableAt = _autoPauseAvailableAt(ps);
            if (block.timestamp < availableAt) revert AutoPauseCoolingDown(availableAt);
            ps.lastAutoPauseUntil = until;
        }
        // The boundary stamp below moves, so a pause the log has not yet
        // recorded reaches it first, from the boundary it stamped. Then,
        // under the manual pause the open interval already covers the
        // window; outside it the window is its own closed interval.
        _recordUnlogged(ps);
        if (!ps.paused) _appendInterval(ps, SafeCast.toUint64(block.timestamp), until);
        ps.pausedUntilTimestamp = until;
        // Stamp the boundary at the START of the auto-pause window. Passive
        // expiry fires no unpause tx, so this is the only boundary marker for
        // an auto-pause; a later observation whose prior sample predates it
        // still discards the interval that straddled the (now-elapsed) window.
        ps.lastPauseBoundaryAt = SafeCast.toUint64(block.timestamp);
        ++ps.pauseTransitions;
        emit AutoPaused(msg.sender, reason, until);
    }

    /// @dev Block-timestamp at which an active auto-pause window
    ///      expires. Zero when no auto-pause is set OR when the
    ///      window has already elapsed. Frontends use this to render
    ///      a countdown without a separate isAutoPaused check.
    function pausedUntil() internal view returns (uint256) {
        uint64 t = _storage().pausedUntilTimestamp;
        return uint256(t) > block.timestamp ? uint256(t) : 0;
    }

    /// @dev #2744 — the effective cooldown between auto-pause windows that
    ///      freeze a live protocol.
    function autoPauseCooldownSeconds() internal view returns (uint256) {
        return _cooldownSeconds(_storage());
    }

    /// @dev #2744 — the first timestamp at which an auto-pause may freeze a
    ///      live protocol: the end of the last such window plus the cooldown,
    ///      read with the cooldown as it is set now. Zero when no window has
    ///      ever frozen a live protocol.
    function autoPauseAvailableAt() internal view returns (uint256) {
        return _autoPauseAvailableAt(_storage());
    }

    /// @dev #2744 — sets the cooldown; 0 restores the default. The caller
    ///      enforces the role; this enforces the bounds, so no caller can set
    ///      a value outside them.
    function setAutoPauseCooldownSeconds(uint32 newSeconds) internal {
        if (
            newSeconds != 0
                && (newSeconds < MIN_AUTO_PAUSE_COOLDOWN || newSeconds > MAX_AUTO_PAUSE_COOLDOWN)
        ) {
            revert InvalidAutoPauseCooldown(newSeconds, MIN_AUTO_PAUSE_COOLDOWN, MAX_AUTO_PAUSE_COOLDOWN);
        }
        _storage().autoPauseCooldownSeconds = newSeconds;
        emit AutoPauseCooldownSet(newSeconds);
    }

    function _cooldownSeconds(PausableStorage storage ps) private view returns (uint256) {
        uint32 v = ps.autoPauseCooldownSeconds;
        return v == 0 ? AUTO_PAUSE_COOLDOWN_DEFAULT : uint256(v);
    }

    function _autoPauseAvailableAt(PausableStorage storage ps) private view returns (uint64) {
        uint64 last = ps.lastAutoPauseUntil;
        if (last == 0) return 0;
        return last + SafeCast.toUint64(_cooldownSeconds(ps));
    }

    // ─── Pause-interval log (#668 / #935, owner decision D2) ────────────────

    /// @dev Opens the interval a manual pause starts. An auto-pause window
    ///      still running is the same pause continuing, so its interval is
    ///      reopened rather than a second one started. Already open (a
    ///      second `pause()`): nothing to do.
    function _openInterval(PausableStorage storage ps) private {
        uint256 n = ps.pauseIntervals.length;
        if (n != 0) {
            PauseInterval storage last = ps.pauseIntervals[n - 1];
            if (last.end == OPEN_END) return;
            if (last.end > block.timestamp) {
                last.end = OPEN_END;
                return;
            }
        }
        _appendInterval(ps, SafeCast.toUint64(block.timestamp), OPEN_END);
    }

    /// @dev Closes the paused interval an unpause ends, at `now`: the open
    ///      manual interval, or an auto-pause window cut short. Called only
    ///      while a pause is in force and after {_recordUnlogged}, so the
    ///      last interval on the log is the one in force.
    function _closeInterval(PausableStorage storage ps) private {
        uint64 nowTs = SafeCast.toUint64(block.timestamp);
        PauseInterval storage last = ps.pauseIntervals[ps.pauseIntervals.length - 1];
        last.end = nowTs;
        emit PauseIntervalClosed(last.start, nowTs, last.pausedBefore + (nowTs - last.start));
    }

    /// @dev The pause the flags record and the log does not, as the interval
    ///      it would be on the log. That is a manual pause in force, or an
    ///      auto-pause window (running or lapsed), set before the log existed
    ///      on a Diamond upgraded in place (#2809 r1). It starts at the
    ///      boundary that pause stamped, never earlier than the end of the
    ///      last recorded interval, so it can only understate the paused time.
    ///      `found` is false when the log already covers the pause state.
    ///      Every reader counts it ({pausedSecondsAt}, {pauseIntervalCount},
    ///      {pauseIntervalAt}) and every writer records it first
    ///      ({_recordUnlogged}), so a loan's pause credit is the same before
    ///      and after the interval reaches the log, and repay stays open
    ///      against the moved deadlines during an inherited pause.
    function _unlogged(PausableStorage storage ps)
        private
        view
        returns (bool found, PauseInterval memory iv)
    {
        uint256 n = ps.pauseIntervals.length;
        uint64 floor;
        if (n != 0) {
            PauseInterval storage last = ps.pauseIntervals[n - 1];
            if (last.end == OPEN_END) return (false, iv);
            floor = last.end;
            iv.pausedBefore = last.pausedBefore + (last.end - last.start);
        }
        iv.start = ps.lastPauseBoundaryAt > floor ? ps.lastPauseBoundaryAt : floor;
        if (ps.paused) {
            iv.end = OPEN_END;
            return (true, iv);
        }
        if (ps.pausedUntilTimestamp > iv.start) {
            iv.end = ps.pausedUntilTimestamp;
            return (true, iv);
        }
        return (false, iv);
    }

    /// @dev Writes {_unlogged}'s interval to the log, unchanged. No-op when
    ///      the log already covers the pause state.
    function _recordUnlogged(PausableStorage storage ps) private {
        (bool found, PauseInterval memory iv) = _unlogged(ps);
        if (found) ps.pauseIntervals.push(iv);
    }

    function _appendInterval(PausableStorage storage ps, uint64 start, uint64 end) private {
        uint256 n = ps.pauseIntervals.length;
        uint64 before;
        if (n != 0) {
            PauseInterval storage prev = ps.pauseIntervals[n - 1];
            before = prev.pausedBefore + (prev.end - prev.start);
        }
        ps.pauseIntervals.push(PauseInterval({start: start, end: end, pausedBefore: before}));
    }

    /// @notice Total time the protocol had been paused before `t`.
    /// @dev    Binary search over the log: the last interval starting at or
    ///         before `t`, plus the part of it before `t`. An open interval
    ///         counts up to `t`. Zero before the first pause. A pause the log
    ///         has not yet recorded ({_unlogged}) is counted as the interval
    ///         it will be recorded as; it starts after every logged one.
    function pausedSecondsAt(uint256 t) internal view returns (uint256) {
        PausableStorage storage ps = _storage();
        (bool found, PauseInterval memory tail) = _unlogged(ps);
        if (found && tail.start <= t) return _pausedWithin(tail, t);
        PauseInterval[] storage log_ = ps.pauseIntervals;
        uint256 lo;
        uint256 hi = log_.length;
        // Find the number of intervals with start <= t.
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (log_[mid].start <= t) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) return 0;
        return _pausedWithin(log_[lo - 1], t);
    }

    /// @dev Paused time before `t` for the interval starting at or before
    ///      `t`: every earlier interval plus the part of this one before `t`.
    function _pausedWithin(PauseInterval memory iv, uint256 t) private pure returns (uint256) {
        uint256 end = iv.end < t ? iv.end : t;
        return uint256(iv.pausedBefore) + (end - iv.start);
    }

    /// @notice Paused time between `from` and `to` (zero when `to <= from`).
    function pausedSecondsBetween(uint256 from, uint256 to) internal view returns (uint256) {
        if (to <= from) return 0;
        return pausedSecondsAt(to) - pausedSecondsAt(from);
    }

    /// @notice Number of intervals on the log, counting a pause in force the
    ///         log has not yet recorded ({_unlogged}) as its last entry.
    function pauseIntervalCount() internal view returns (uint256) {
        PausableStorage storage ps = _storage();
        (bool found, ) = _unlogged(ps);
        return ps.pauseIntervals.length + (found ? 1 : 0);
    }

    /// @notice One interval of the log; `end == OPEN_END` while open. The
    ///         entry past the stored ones is the unrecorded pause, exactly as
    ///         the next pause-state change will record it.
    function pauseIntervalAt(uint256 i) internal view returns (PauseInterval memory) {
        PausableStorage storage ps = _storage();
        if (i < ps.pauseIntervals.length) return ps.pauseIntervals[i];
        (bool found, PauseInterval memory tail) = _unlogged(ps);
        if (!found || i != ps.pauseIntervals.length) revert PauseIntervalOutOfRange(i);
        return tail;
    }

    /// @dev Block-timestamp at which the pause STATE last changed (pause /
    ///      unpause / auto-pause set). Zero when the protocol has never been
    ///      paused. Time-accounting consumers use it to drop any observation
    ///      interval that straddled a pause window — see `lastPauseBoundaryAt`
    ///      in {PausableStorage}.
    function lastPauseBoundaryAt() internal view returns (uint64) {
        return _storage().lastPauseBoundaryAt;
    }
}

/**
 * @dev Thin abstract contract providing whenNotPaused/whenPaused modifiers
 *      backed by LibPausable's namespaced storage. Has zero state variables,
 *      so it's safe to inherit in diamond facets without storage collisions.
 */
abstract contract DiamondPausable {
    modifier whenNotPaused() {
        LibPausable.requireNotPaused();
        _;
    }

    modifier whenPaused() {
        LibPausable.requirePaused();
        _;
    }
}
