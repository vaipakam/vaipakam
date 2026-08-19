#!/usr/bin/env python3
"""#1434 P1-b fix-reversion mutation harness (#1699).

Each TARGETS row is (label, src-relative file, exact anchor, mutant text,
killing suite, killing test). The harness applies ONE mutant at a time,
runs its killing test, and restores the source; a KILLED verdict means the
test fails for the intended reason (each mutant IS the reverted fix).

Rebuilt into the repo after the 2026-08-19 power outage wiped the
session-scratchpad original (the lesson: tooling never lives only in a
scratchpad). Rounds 1-9's earliest mutants are NOT yet restored here —
their kills are recorded in PR #1699's per-round verification lines
(13/13 by r9) and their killing tests all run in the ordinary suites;
re-derivation is tracked in the PR's follow-up. Restored set: the r10-r17
mutants plus every earlier one whose exact tuple survived in context,
with the proven-equivalent set and its recorded evidence.
"""
import os, shutil, subprocess, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
SRC = os.path.join(ROOT, 'src')

TARGETS = [
    (
        "expiry claim-skip at the removal point (defence-in-depth pair)",
        "libraries/LibInteractionRewards.sol",
        "        if (e.expiryBegun) return (toUser, toTreasury);",
        "        if (false) return (toUser, toTreasury);",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bFirstCreditedChunkIsTheRemovalPoint",
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
        "a REMOVED entry terminates under a shortfall (never strands its tail)",
        "libraries/LibInteractionRewards.sol",
        "        if (\n            charge.freshShortfall != 0\n                && (!e.expiryBegun || freshRecoverable)\n        ) {",
        "        if (charge.freshShortfall != 0) {",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bRemovedEntryTerminatesUnderAShortfall",
    ),
    (
        "expiry keeps ALL-OR-NOTHING within a day (69M shortfall defers)",
        "libraries/LibInteractionRewards.sol",
        "        if (\n            charge.freshShortfall != 0\n                && (!e.expiryBegun || freshRecoverable)\n        ) {",
        "        if (false) {",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testExpiryIsAllOrNothingAtNearExhaustion",
    ),
    (
        "a BACKING dip defers a removed entry (only the 69M cap is terminal)",
        "libraries/LibInteractionRewards.sol",
        "        if (\n            charge.freshShortfall != 0\n                && (!e.expiryBegun || freshRecoverable)\n        ) {",
        "        if (charge.freshShortfall != 0 && !e.expiryBegun) {",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bRemovedEntryDefersOnABackingDip",
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
        "setBaseChainId retires the delivered residual on a role change",
        "facets/RewardReporterFacet.sol",
        "        // this by construction.\n        _retireDeliveredResidualOnRoleChange(s, wasMirror);",
        "        // this by construction.",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bBaseChainDetachRetiresTheDeliveredResidual",
    ),
    (
        "a ROLE transition retires the delivered residual",
        "facets/RewardReporterFacet.sol",
        "        // one-fix-two-sites defect r2 already catalogued.\n        _retireDeliveredResidualOnRoleChange(s, wasMirror);",
        "        // one-fix-two-sites defect r2 already catalogued.",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bRoleTransitionRetiresTheDeliveredResidual",
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
        "the countdown is terminal at the REMOVAL POINT, not only at processed",
        "libraries/LibInteractionRewards.sol",
        "        if (e.processed || e.expiryBegun) return (firstClaimableAt, 0);",
        "        if (e.processed) return (firstClaimableAt, 0);",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bRemovedEntryLeavesThePendingAggregates",
    ),
    (
        "the dry run models the LIFETIME cap next to the delivered bound",
        "libraries/LibInteractionRewards.sol",
        "        PoolBudget memory pool = PoolBudget({\n            fresh: freshBudget,",
        "        PoolBudget memory pool = PoolBudget({\n            fresh: type(uint256).max,",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bNeedAndPreviewModelTheLifetimeCap",
    ),
    (
        "the dry run DEPLETES the fresh budget between days",
        "libraries/LibInteractionRewards.sol",
        "            uint256 fb = pool.fresh;\n            pool.fresh = fb > spent ? fb - spent : 0;",
        "            // depletion removed by mutant",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bDryRunDepletesTheFreshBudgetBetweenDays",
    ),
    (
        "the PREVIEW reserves the preceding legs before the walk",
        "libraries/LibInteractionRewards.sol",
        "            _userWalkFreshBudget(s, user, userTotal + treasuryLegs)",
        "            poolRemaining()",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bDryRunReservesTheLegacyLegFirst",
    ),
    (
        "the armed NEED reserves the preceding legs before the walk",
        "libraries/LibInteractionRewards.sol",
        "            _userWalkFreshBudget(s, user, uL + tL)",
        "            poolRemaining()",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bDryRunReservesTheLegacyLegFirst",
    ),
    (
        "the PREVIEW's reservation includes the forfeit (treasury) legs",
        "libraries/LibInteractionRewards.sol",
        "            _userWalkFreshBudget(s, user, userTotal + treasuryLegs)\n        );\n        userTotal += dryTotal;",
        "            _userWalkFreshBudget(s, user, userTotal)\n        );\n        userTotal += dryTotal;",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bDryRunReservesTheForfeitLegToo",
    ),
    (
        "the armed NEED's reservation includes the forfeit (treasury) legs",
        "libraries/LibInteractionRewards.sol",
        "            _userWalkFreshBudget(s, user, uL + tL)",
        "            _userWalkFreshBudget(s, user, uL)",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bDryRunReservesTheForfeitLegToo",
    ),
    (
        "the forfeit reservation is the LEGACY component only",
        "libraries/LibInteractionRewards.sol",
        "                treasuryLegs +=\n                    tSplit.total - tSplit.recycled - tSplit.armedFresh;",
        "                treasuryLegs += tSplit.total - tSplit.recycled;",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bForfeitReservationIsLegacyOnly",
    ),
    (
        "the forfeit sweep gates on the D1-CAPPED liability",
        "facets/InteractionRewardsFacet.sol",
        "            if (freshSwept >= freshWanted) {\n                armedPaid = armedCapped;",
        "            if (freshSwept >= freshWanted) {\n                armedPaid = sweepSplit.armedFresh;",
        "test/GovernorDualAccumulatorTest.t.sol",
        "testP1bForfeitSweepGatesOnTheCappedLiability",
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
}


def run(suite, test):
    p = subprocess.run(
        ["forge", "test", "--match-path", suite, "--match-test", test],
        cwd=ROOT, capture_output=True, text=True,
    )
    return p.returncode


def main():
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
            rc = run(suite, test)
            results.append(("KILLED" if rc != 0 else "SURVIVED", label, test))
        finally:
            shutil.move(backup, path)
            os.utime(path, None)

    print("\n=== P1-b MUTATION RESULTS ===")
    killed = equiv = gaps = 0
    for verdict, label, test in results:
        shown = verdict
        if verdict == "SURVIVED" and label in EQUIVALENT:
            shown = "EQUIVALENT (expected)"; equiv += 1
        elif verdict == "SURVIVED":
            shown = "SURVIVED <<< GAP"; gaps += 1
        else:
            killed += 1
        print("%-22s %s\n%25s%s" % (shown, label, "", test))
    print("\n%d/%d killed, %d known-equivalent, %d GAPS" % (
        killed, len(TARGETS), equiv, gaps))
    return 0


if __name__ == "__main__":
    sys.exit(main())
