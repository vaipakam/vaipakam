#!/usr/bin/env python3
"""#1434 P1-b fix-reversion mutation harness (#1699).

Each TARGETS row is (label, src-relative file, exact anchor, mutant text,
killing suite, killing test). The harness applies ONE mutant at a time,
runs its killing test, and restores the source; a KILLED verdict means the
test fails for the intended reason (each mutant IS the reverted fix).
KILLED requires a `[FAIL...]` line from forge: a mutant that breaks the
build exits nonzero without running any test and is reported NO-RUN, never
as a kill. Every anchor must occur exactly once or the run ABORTs before
touching anything; the exit code is nonzero on any GAP or NO-RUN.

Run from the repo root:
    FOUNDRY_PROFILE=default nice -n -10 ionice -c 2 -n 0 \
      python3 contracts/script/mutation/p1b_mutants.py

Rebuilt into the repo after the 2026-08-19 power outage wiped the
session-scratchpad original (the lesson: tooling never lives only in a
scratchpad). Restored set: the r10-r17 mutants plus every earlier one
whose exact tuple survived in context, with the proven-equivalent set and
its recorded evidence.

ROUNDS 1-9 (#1827). Re-derived from PR #1699's r1-r9 commits against the
CURRENT code, never from memory: each fix was located in its present form,
its anchor checked to occur exactly once, and its killer run with the mutant
applied and confirmed to fail at an assertion or a revert inside the test
(not at compile). Where a kill now arrives through the #1566 closure-2
chokepoint (`DeliveredFreshBoundExceeded`), the fix still matters: without
it the whole claim or sweep reverts where the rule is that the day defers.

  Covered by a tuple added here:
    r1  claim-walk delivered depletion        -> DeliveredFreshBoundExceeded
    r1  forfeit armed leg bounded by delivery -> DeliveredFreshBoundExceeded
        (r1's whole-sweep revert became a per-day defer in r18, 662144253)
    r1  expiry armed leg bounded by the batch allowance -> killed through the
        allowance's BACKING-room component (InsufficientRecycleBacking).
        Before the removal point the clock gate (r2) masks the delivered-
        ledger component, so no test isolates that component alone.
    r2  the clock's delivered-payable predicate -> assertion
    r7  spanning-entry bootstrap               -> RewardEntrySetMismatch(1),
        the revert r7 reported
    r8  wholly-legacy dispatch before the cursor read -> assertion
    r8  the removal point, on BOTH legs that can be the first credited chunk
        (spanning legacy leg; armed chunk)     -> assertion each
    r8  `armedFrom < e.endDay`: EQUIVALENT, see EQUIVALENT below.

  Already covered by an existing tuple (re-anchored below):
    r6  all-or-nothing within a day   ("expiry keeps ALL-OR-NOTHING ...")
    r8  claim-skip at the removal point ("expiry claim-skip ...", equivalent)
    r9  removal-point sequencing      ("a REMOVED entry terminates ...")
    r9  role-transition residual retire ("a ROLE transition retires ...")

  Retired -- the code no longer exists:
    r1  pro-rata round-up and the `DeliveredFreshShortfall` forfeit revert,
        and r2's post-cap forfeit gate: removed when the forfeit armed leg
        moved onto the day engine (r18, 662144253)
    r1  expiry's folded all-or-nothing gate, r4's loan-side-capped gate and
        r5's D1-stage gate: the bespoke gate was deleted (r6, 0263f011a1)
    r2/r3/r4  `seedArmedFreshPaid`, its refresh ceremony and its no-default
        guard: retired with the paid-side seed (#2944, 7d6d093cc)
    r3  mirror-only scoping of the paid-side writers: superseded by the
        closure-2 chokepoint `chargeDeliveredFresh`, the one writer of the
        paid side for every role (#2151, 280ca7d50)
    r4  the unarmed-day guards: refuted in r4 (equivalent), `_isArmedDay`
        arm removed in r8 (9d235ca26f)

  Gaps -- the fix survives but no test can kill its reversion:
    r2  the expiry BATCH allowance depletion (RewardHorizonSweepFacet): no
        test sweeps two entries against an allowance that fits only one
    r3  the clock's per-USER aggregate need: GovernorDualAccumulatorTest's
        own note above testP1bFirstCreditedChunkIsTheRemovalPoint records
        that its day-pool sizing cannot separate grouped from per-entry
    r4  `_entryArmedNeed` failing closed: no test makes the lens staticcall
        fail or return short
    r7  the whole-entry expiry accumulators: tests count the
        `RewardEntryExpired` event, none decode its totals
    r8  the unstamped-armed-day defer: r8 recorded it unreachable (finalize
        writes the mode stamp and the row together)

ROUNDS 10+ RE-ANCHORED (#1827). Seventeen of the tuples restored after the
outage no longer matched main, so the harness aborted and covered nothing.
Each was given the same treatment as r1-r9:

  Re-anchored to the current form of the same fix, killer re-verified:
    claim-skip at the removal point (still EQUIVALENT: survives its test)
    removed entry terminates / all-or-nothing within a day: one gate now,
        `freshShortfall != 0 && !e.expiryBegun` (the `freshRecoverable`
        operand was retired in #2276, f3579b823)
    backing dip defers a removed entry: since #2276 backing rides in the
        delivered allowance, so the fix is now the sweep facet's
        `backingCap < allowance` clamp
    both role-change residual retirements (helper now takes before/after)
    the countdown terminal at the removal point (now also skips forfeits)
    the dry run's lifetime cap, legacy-leg reservation and forfeit-leg
        reservation: one budget in `_staticPool` since #2459 (cc94a0a3d)
    the forfeit reservation's legacy-only component
    the wholly-legacy forfeit's headroom clamp
    the spanning forfeit legacy leg's defer: since #2276 the backing bound
        is the delivered allowance, so the fix is its `deliveredAllowance`
        defer

  Retired:
    the PREVIEW's two reservation rows: since #2459 (cc94a0a3d) the preview
        prices its armed part through the same `_staticPool` as the armed
        need, so they were the NEED rows' mutants a second time
    "the forfeit charges the bound by DELIVERED, never by owed": the facet's
        own mirror-guarded paid-side write was removed by #2151 (280ca7d50);
        the chokepoint now charges what moves

  Gap, removed from TARGETS:
    "the dry run DEPLETES the fresh budget between days": since #2459 the
        static read prices each side's FIRST pending day only, so the
        depletion now acts between the two sides, and the whole
        GovernorDualAccumulatorTest suite passes with it deleted
"""
import os, shutil, signal, subprocess, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
SRC = os.path.join(ROOT, 'src')

TARGETS = [
    # --- Rounds 1-9, re-derived against main (#1827) ---
    (
        'r1: the claim walk DEPLETES its delivered budget between days',
        'libraries/LibInteractionRewards.sol',
        '                ctx.pool.deliveredFresh =\n                    db > liveSpent ? db - liveSpent : 0;',
        '                ctx.pool.deliveredFresh = db;',
        'test/ShareOfPoolClaimWalkTest.t.sol',
        'test_P1b_DeliveredBoundDepletesAcrossDaysInOneClaim',
    ),
    (
        "r1: the forfeit's armed day prices against the DELIVERED allowance",
        'libraries/LibInteractionRewards.sol',
        '        set[0] = id;\n        (DayCharge memory charge, DaySlice[] memory slices) =\n            processUserSideDay(\n                e.user,\n                d,\n                set,\n                PoolBudget({\n                    fresh: freshHeadroom,\n                    recycled: LibVpfiRecycle.bucketAvailable(s),\n                    deliveredFresh: deliveredAllowance',
        '        set[0] = id;\n        (DayCharge memory charge, DaySlice[] memory slices) =\n            processUserSideDay(\n                e.user,\n                d,\n                set,\n                PoolBudget({\n                    fresh: freshHeadroom,\n                    recycled: LibVpfiRecycle.bucketAvailable(s),\n                    deliveredFresh: type(uint256).max',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bForfeitSweepRefusesWhenDeliveredIsShort',
    ),
    (
        "r1: expiry's armed day prices against the batch DELIVERED allowance",
        'libraries/LibInteractionRewards.sol',
        '        ctx.recycleSettlement = true;\n        (DayCharge memory charge, DaySlice[] memory slices) = processUserSideDay(\n            e.user,\n            d,\n            set,\n            PoolBudget({\n                fresh: freshHeadroom,\n                recycled: LibVpfiRecycle.bucketAvailable(s),\n                deliveredFresh: deliveredAllowance',
        '        ctx.recycleSettlement = true;\n        (DayCharge memory charge, DaySlice[] memory slices) = processUserSideDay(\n            e.user,\n            d,\n            set,\n            PoolBudget({\n                fresh: freshHeadroom,\n                recycled: LibVpfiRecycle.bucketAvailable(s),\n                deliveredFresh: type(uint256).max',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bRemovedEntryDefersOnABackingDip',
    ),
    (
        'r2: the expiry clock does not run while delivered funding is short',
        'libraries/LibInteractionRewards.sol',
        '            bool deliveredPayable = freshNeed == 0\n                || freshNeed <= deliveredFreshBound(s);',
        '            bool deliveredPayable = freshNeed == freshNeed;',
        'test/RewardHorizonClaimAgreementTest.t.sol',
        'test_DeliveredBound_StraddlesOneWei_PredicateClockAndClaimAgree',
    ),
    (
        'r8: a WHOLLY pre-cutover entry dispatches before the cursor is read',
        'libraries/LibInteractionRewards.sol',
        '        if (armedFrom == 0 || e.endDay <= armedFrom) {\n            EntrySplit memory whole = st.rawSplit;',
        '        if (armedFrom == 0) {\n            EntrySplit memory whole = st.rawSplit;',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bWhollyLegacyEntryTerminalisesOnceOnly',
    ),
    (
        'r7: a SPANNING entry reaps its legacy leg, then its armed tail',
        'libraries/LibInteractionRewards.sol',
        '        if (\n            armedFrom != 0\n                && e.startDay < armedFrom\n                // Codex #1699 r8 P1',
        '        if (\n            false\n                && e.startDay < armedFrom\n                // Codex #1699 r8 P1',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bSpanningEntryReapsAcrossTheCutover',
    ),
    (
        'r8: the spanning bootstrap requires armedFrom < endDay',
        'libraries/LibInteractionRewards.sol',
        '                // SAME ENTRY AGAIN. A wholly pre-cutover entry belongs to the\n                // terminal branch below, which marks it processed.\n                && armedFrom < e.endDay\n',
        '                // SAME ENTRY AGAIN. A wholly pre-cutover entry belongs to the\n                // terminal branch below, which marks it processed.\n',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bWhollyLegacyEntryTerminalisesOnceOnly|testP1bSpanningEntryReapsAcrossTheCutover',
    ),
    (
        "r8: a spanning entry's credited legacy leg is the removal point",
        'libraries/LibInteractionRewards.sol',
        '            if (legacyFresh != 0) _beginExpiry(s, id, e);',
        '            if (false) _beginExpiry(s, id, e);',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bFirstCreditedChunkIsTheRemovalPoint',
    ),
    (
        'r8: a credited armed chunk is the removal point',
        'libraries/LibInteractionRewards.sol',
        '        if (charge.toTreasury.total != 0) _beginExpiry(s, id, e);',
        '        if (false) _beginExpiry(s, id, e);',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bZeroCreditChunkDoesNotRemove',
    ),
    # --- Rounds 10+ (re-anchored against main, #1827) ---
    (
        'expiry claim-skip at the removal point (defence-in-depth pair)',
        'libraries/LibInteractionRewards.sol',
        '        if (e.expiryBegun) return (toUser, toTreasury, 0, stepped);',
        '        if (false) return (toUser, toTreasury, 0, stepped);',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bFirstCreditedChunkIsTheRemovalPoint',
    ),
    (
        "a CAPPED-ONLY terminal chunk still retires its commitment",
        "facets/RewardHorizonSweepFacet.sol",
        "        if (t.fresh + t.recycled == 0 && t.armedFresh == 0) return 0;",
        "        if (t.fresh + t.recycled == 0) return 0;",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bRemovedEntryTerminatesUnderAShortfall",
    ),
    (
        'a REMOVED entry terminates under a shortfall (never strands its tail)',
        'libraries/LibInteractionRewards.sol',
        '        if (charge.freshShortfall != 0 && !e.expiryBegun) {',
        '        if (charge.freshShortfall != 0) {',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bRemovedEntryTerminatesUnderAShortfall',
    ),
    (
        'expiry keeps ALL-OR-NOTHING within a day (69M shortfall defers)',
        'libraries/LibInteractionRewards.sol',
        '        if (charge.freshShortfall != 0 && !e.expiryBegun) {',
        '        if (false) {',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testExpiryIsAllOrNothingAtNearExhaustion',
    ),
    (
        'a BACKING dip defers a removed entry (only the 69M cap is terminal)',
        'facets/RewardHorizonSweepFacet.sol',
        '        if (backingCap < allowance) allowance = backingCap;\n        // 3b-ii-A — the epoch-paid legs the sweep draws, absorbed net below.',
        '        // 3b-ii-A — the epoch-paid legs the sweep draws, absorbed net below.',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bRemovedEntryDefersOnABackingDip',
    ),
    (
        "removal begins on the first chunk that CREDITS, not merely advances",
        "libraries/LibInteractionRewards.sol",
        "        if (charge.toTreasury.total != 0) _beginExpiry(s, id, e);",
        "        _beginExpiry(s, id, e);",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bZeroCreditChunkDoesNotRemove",
    ),
    (
        'setBaseChainId retires the delivered residual on a role change',
        'facets/RewardReporterFacet.sol',
        '        // this by construction.\n        _retireDeliveredResidualOnRoleChange(s, before, old);',
        '        // this by construction.',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bBaseChainDetachRetiresTheDeliveredResidual',
    ),
    (
        'a ROLE transition retires the delivered residual',
        'facets/RewardReporterFacet.sol',
        '        // one-fix-two-sites defect r2 already catalogued.\n        _retireDeliveredResidualOnRoleChange(s, before, s.baseChainId);',
        '        // one-fix-two-sites defect r2 already catalogued.',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bRoleTransitionRetiresTheDeliveredResidual',
    ),
    (
        "the executable AGGREGATE excludes removed entries",
        "libraries/LibInteractionRewards.sol",
        "                // own settlement never consults this gate — post-removal\n                // chunks bypass it.\n                && !e.expiryBegun\n                && _entryClaimable(s, e)",
        "                // own settlement never consults this gate — post-removal\n                // chunks bypass it.\n                && _entryClaimable(s, e)",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bRemovedEntryLeavesThePendingAggregates",
    ),
    (
        "the pending PREVIEW excludes removed entries",
        "libraries/LibInteractionRewards.sol",
        "            if (e.processed || e.expiryBegun) {\n                unchecked { ++i; }\n                continue;\n            }",
        "            if (e.processed) {\n                unchecked { ++i; }\n                continue;\n            }",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bRemovedEntryLeavesThePendingAggregates",
    ),
    (
        'the countdown is terminal at the REMOVAL POINT, not only at processed',
        'libraries/LibInteractionRewards.sol',
        '        if (e.processed || e.expiryBegun || _isForfeited(s, e)) return (firstClaimableAt, 0);',
        '        if (e.processed || _isForfeited(s, e)) return (firstClaimableAt, 0);',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bRemovedEntryLeavesThePendingAggregates',
    ),
    (
        'the dry run models the LIFETIME cap next to the delivered bound',
        'libraries/LibInteractionRewards.sol',
        '            fresh: _userWalkFreshBudget(s, user, need.userLegs + need.treasuryLegs),',
        '            fresh: type(uint256).max,',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bNeedAndPreviewModelTheLifetimeCap',
    ),
    (
        'the armed NEED reserves the preceding legs before the walk',
        'libraries/LibInteractionRewards.sol',
        '            fresh: _userWalkFreshBudget(s, user, need.userLegs + need.treasuryLegs),',
        '            fresh: poolRemaining(),',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bDryRunReservesTheLegacyLegFirst',
    ),
    (
        "the armed NEED's reservation includes the forfeit (treasury) legs",
        'libraries/LibInteractionRewards.sol',
        '            fresh: _userWalkFreshBudget(s, user, need.userLegs + need.treasuryLegs),',
        '            fresh: _userWalkFreshBudget(s, user, need.userLegs),',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bDryRunReservesTheForfeitLegToo',
    ),
    (
        'the forfeit reservation is the LEGACY component only',
        'libraries/LibInteractionRewards.sol',
        '                uint256 tFresh =\n                    tSplit.total - tSplit.recycled - tSplit.armedFresh;',
        '                uint256 tFresh =\n                    tSplit.total - tSplit.recycled;',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bForfeitReservationIsLegacyOnly',
    ),
    (
        'a wholly-legacy forfeit clamps to the remaining pool headroom',
        'libraries/LibInteractionRewards.sol',
        '            if (live > freshHeadroom) live = freshHeadroom;\n            tp.treasuryFresh += ef;',
        '            tp.treasuryFresh += ef;',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bWhollyLegacyForfeitClampsToTheHeadroom',
    ),
    (
        "a spanning forfeit's legacy leg defers on a backing-bound shortfall",
        'libraries/LibInteractionRewards.sol',
        '            if (legacyFresh > deliveredAllowance) return (0, 0, 0, 0);\n            s.rewardEntryClaimNextDay[id] = SafeCast.toUint64(armedFrom);',
        '            s.rewardEntryClaimNextDay[id] = SafeCast.toUint64(armedFrom);',
        'test/GovernorDualAccumulatorTest.t.sol',
        'testP1bSpanningForfeitLegacyLegDefersOnABackingDip',
    ),
    (
        "an UNPRICED wholly-legacy preflight defers the forfeit settle",
        "libraries/LibInteractionRewards.sol",
        "                if (!pst.priced && !pst.emptyWindow) return (0, 0, 0, 0);",
        "                // unpriced-preflight gate removed by mutant",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bFarBehindLegacyForfeitDefersWhileUnpriced",
    ),
]

# Proven EQUIVALENT: expected to SURVIVE, each with recorded evidence.
EQUIVALENT = {
    # Reachability (measured r8): the removal point is enforced in the
    # worklist (load-bearing) and _processEntry (redundant defence-in-depth).
    "expiry claim-skip at the removal point (defence-in-depth pair)",
    # Reachability (measured, pre-merge review 2026-08-17): a removed entry
    # always has `processed` or a stamped cursor, which the preview already
    # prices at zero; the aggregate filter is the load-bearing one.
    "the pending PREVIEW excludes removed entries",
    # Reachability (measured #1827): r8's own dispatch reorder returns every
    # entry with endDay <= armedFrom from the wholly-legacy branch BEFORE the
    # spanning test is evaluated, so the r8 `armedFrom < e.endDay` conjunct
    # can no longer be the deciding term. Both its killers pass with it gone.
    "r8: the spanning bootstrap requires armedFrom < endDay",
}


def run(suite, test):
    """Run one killer; return (verdict, evidence).

    A nonzero exit counts as KILLED only when forge actually ran the test
    and it failed at runtime (a `[FAIL...]` line). A mutant that breaks the
    build makes forge exit nonzero with no test run at all, and counting
    that as a kill would score a mutant no test ever saw (#1827).
    """
    p = subprocess.run(
        ["forge", "test", "--match-path", suite, "--match-test", test],
        cwd=ROOT, capture_output=True, text=True,
    )
    out = p.stdout + p.stderr
    fails = [l for l in out.splitlines() if l.startswith("[FAIL")]
    if p.returncode == 0:
        return "SURVIVED", ""
    if fails:
        return "KILLED", fails[0][:160]
    return "NO-RUN", "forge exited %d without a failing test" % p.returncode


def _terminate(signum, _frame):
    # A SIGTERM/SIGHUP (a timed-out wrapper, a closed terminal) would end the
    # process between the mutant write and the restore, leaving a reverted fix
    # in src/. Raising here unwinds through main()'s `finally`, which restores.
    raise SystemExit(128 + signum)


def main():
    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGHUP, _terminate)
    stale = []
    for label, rel, find, repl, suite, test in TARGETS:
        body = open(os.path.join(SRC, rel)).read()
        if body.count(find) != 1:
            stale.append("%s (%d hits)" % (label, body.count(find)))
    if stale:
        print("ABORT -- anchors not clean:")
        for x in stale:
            print("   " + x)
        return 1

    results = []
    for label, rel, find, repl, suite, test in TARGETS:
        path = os.path.join(SRC, rel)
        backup = path + ".p1bbak"
        shutil.copy2(path, backup)
        try:
            src = open(path).read()
            open(path, "w").write(src.replace(find, repl))
            os.utime(path, None)
            verdict, why = run(suite, test)
            results.append((verdict, label, test, why))
            print("[%d/%d] %s  %s" % (len(results), len(TARGETS), verdict, label),
                  flush=True)
        finally:
            shutil.move(backup, path)
            os.utime(path, None)

    print("\n=== P1-b MUTATION RESULTS ===")
    killed = equiv = gaps = norun = 0
    for verdict, label, test, why in results:
        shown = verdict
        if verdict == "SURVIVED" and label in EQUIVALENT:
            shown = "EQUIVALENT (expected)"; equiv += 1
        elif verdict == "SURVIVED":
            shown = "SURVIVED <<< GAP"; gaps += 1
        elif verdict == "NO-RUN":
            shown = "NO-RUN <<< NOT A KILL"; norun += 1
        else:
            killed += 1
        print("%-22s %s\n%25s%s" % (shown, label, "", test))
        if why:
            print("%25s%s" % ("", why))
    print("\n%d/%d killed, %d known-equivalent, %d GAPS, %d NO-RUN" % (
        killed, len(TARGETS), equiv, gaps, norun))
    return 1 if (gaps or norun) else 0


if __name__ == "__main__":
    sys.exit(main())
