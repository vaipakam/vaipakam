# Keeper backup on Chainlink Automation (#3361)

## Why

Every permissionless step that keeps the protocol moving has our keeper behind
it. That keeper runs on one machine. If the machine is down, out of gas or
wedged, a step nobody else bothers to call stays undone: a past-grace default,
a daily rental deduction, an expired listing, a reward day close. Raaj approved
an outside backup on 2026-11-08 and chose Chainlink Automation as the network
that runs it.

The backup is a second runner, not a second keeper. It acts only when our
keeper is late, and only on steps whose due rule the protocol itself checks.

## What it is

One standalone, non-upgradeable contract per chain,
`contracts/src/keeper/KeeperBackupUpkeep.sol`, registered as a Chainlink
"custom logic" upkeep. It holds no funds of its own, carries no copy of any
step's due rule, and ships with every step switched off.

- `checkUpkeep` is simulated by Chainlink's nodes and never sent. It refuses a
  real transaction (Chainlink's `cannotExecute` convention: the simulation runs
  with `tx.origin` at the zero address or `0x1111…1111`).
- `performUpkeep` accepts only the upkeep's forwarder, and only a list of
  (step id, argument) pairs. The call each pair makes is rebuilt inside the
  contract from the step id, always with an empty swap route, so even a
  compromised forwarder can do nothing but call the listed permissionless
  steps, which anyone may already call.
- The owner (the admin multisig on a mainnet) sets the forwarder, arms steps
  one by one, and tunes bounded timing and scan settings. The owner cannot
  move tokens.

## How a step is found, waited on and run

**Finding.** Each check builds candidate calls for the armed steps:

- the VaultBeacon's two proposal executes (one candidate each);
- each day step for the last `dayWindow` closed days (default 7), counting
  back from yesterday, and for a rotating window of `dayWindow` days over
  every older day, moving on every 5 minutes (a day's lapse opens only after
  its finalize and a lapse window, often weeks after the day);
- each loan step for a rotating window of the active-loan list (default 10
  loans, moving on every 5 minutes);
- the stale-sale-listing teardown for the linked loan of each offer in a
  rotating window of the active-offer list.

The note queue and these four kinds of candidate (the days split into
recent and older) are six parts that share the check's gas. The part that
goes first moves on every block, and so does the first (step, argument) pair
inside each part, so a probe that is costly or runs out of its gas (a close
whose frontier is far behind, a default with a long consolidation scan) cannot
starve the rest: each part leads one check in six, and each pair leads its
part in turn.

Whether a candidate is due is the protocol's answer, not ours. The contract
calls the step from a self-call (`probe`) that always reverts with the
result, so the step's effects are undone and only "it would succeed" is kept.
This is why the backup cannot drift from the protocol's rules: it has none of
its own. One step needs an extra rule: `recycleSkippedDayValue` succeeds with
zero once nothing is left, so it is due only while its probe returns a
non-zero amount.

**Waiting.** A due candidate is first noted, in a cheap transaction: it
joins a bounded queue (at most 64) with the time it was seen. Every check
visits the whole queue before it scans, so a noted candidate is revisited
however far the rotating loan, offer and day windows have moved away from it.
It runs only if a check still finds it due between `lagSec` (default 1 hour)
and `lagSec + actWindowSec` (default 1 more hour) after the note. If our
keeper runs the step in the meantime, the probe fails and the note is
dropped, during its wait as well, so the next occurrence of a recurring step
is noted afresh instead of running on the old note's time; the perform probes
again before it drops, so a drop removes only
what is truly no longer due (or a step since disarmed). A note older than its
window is renewed if the step is still due, so a step that recurs (a daily
deduction) waits the full lag every time. While the queue is full no new note
is taken; every entry leaves within one lag and run window of its note.
`firstSeenAt(step, arg)` and `pendingCandidates()` show the queue.

**Running.** A perform runs at most `runsPerPerform` steps (default 2, at most
4). Each run clears its note first and emits `BackupStepRun(step, arg, ok,
revertSelector)`; a run that reverts (someone ran it between check and
perform) is recorded and changes nothing. `BackupDueNoted` marks every wait
that starts and `BackupNoteDropped` every wait that ended without a run, so
the ops side can see from events alone that the backup found our keeper late
and whether our keeper caught up.

## The steps (the "clean set")

Raaj's scope card offered three sets; this build is the recommended "clean
set". Every step below is permissionless, needs no off-chain input, and is
found from on-chain reads.

| Id | Step | Found from | Keeper pass it backs |
| --- | --- | --- | --- |
| 0 | `autoDeductDaily` | active loans | positionUpkeep |
| 1 | `cancelExpiredPrepayListing` | active loans | expiredTeardown |
| 2 | `cancelExpiredIntent` | active loans | expiredTeardown |
| 3 | `autoListAtFloorOnGrace` | active loans | prepayAutoList |
| 4 | `triggerDefault(id, 0, [])` | active loans | graceDefault (no-sale route only) |
| 5 | `settlePeriodicInterest(id, 0, [])` | active loans | periodicSettle (stamp path only) |
| 6 | `teardownStaleSaleListing` | active loans, active offers' linked loans | expiredTeardown |
| 7 | `closeDay` | recent days | rewardDayClose (only where the chain charges no fee) |
| 8 | `lapseZeroedDay` | recent days | rewardZeroedDay |
| 9 | `lapseShortCompensatedDay` | recent days | rewardZeroedDay |
| 10 | `skipConflictedDay` | recent days | rewardDeliveryConflict |
| 11 | `recycleSkippedDayValue` | recent days, non-zero only | rewardDeliveryConflict |
| 12 | VaultBeacon `executeCurrentVersion` | the beacon | vaultBeaconUpkeep |
| 13 | VaultBeacon `executeRevoke` | the beacon | vaultBeaconUpkeep |

Two limits worth stating plainly:

- **A default or periodic settlement that needs a sale is not backed.** The
  backup passes an empty swap route, which the protocol refuses on the sale
  route. So it backs the default of a loan whose collateral is not sold
  (illiquid collateral, or the in-kind route), and the stamp of a period the
  borrower already paid. A liquid loan past grace still depends on our keeper
  or on any third party.
- **`closeDay` runs only where it is free.** It is payable, and a chain that
  charges a CCIP fee for it refuses a call that attaches none, so the probe
  fails there and the backup never runs it. On Base it is free.

## What is not backed, and why

- **Steps that pay a CCIP fee.** The backup holds no native coin and attaches
  no value to any call. Giving it a fee balance would put a spendable
  balance on a contract driven from outside.
- **Steps that need swap quotes or page arguments computed off-chain**:
  every sale, liquidation, match and buyback fill. Liquidations and matching
  are left to open competition on purpose.
- **Steps whose items are found only from event logs**: the protected-account
  releases and changes, pins, reward staging, buyback expiry, sanctions
  refresh, tier pushes. A small read added to the protected-account facets
  would admit the delayed releases; that is Raaj's "add releases too" option,
  coordinated with the thread working in those facets.
- **`finalizeDay`**: it cannot be undone, and our keeper holds it on facts it
  reads from other chains.
- **`backstopFill`**: it lends treasury capital.
- **Steps that succeed without being due** (`advanceInterestFrontiers`,
  `refreshTierLtvCache`, `epochPruneTransportDayCursor`): a probe cannot tell
  due from not due, so running them on that answer would spend gas for
  nothing. One consequence is stated plainly: when a skipped day's first
  window of transport epochs is spent or residual-only, `recycleSkippedDayValue`
  returns zero and the value beyond that window waits for our keeper, which
  prunes the cursor. The prune does not say whether it moved, so the backup
  cannot back it yet; #3378 asks it to.

## Value and authority

- The backup sends no value. A step can still pay its caller: a time-based
  default that settles through an internal match pays the matcher bonus to
  `msg.sender`. Such tokens can leave only to the treasury the contract read
  from the Diamond at deployment, through the permissionless `sweep`. The
  owner cannot redirect them.
- The backup does not respect keeper-side holds. If our keeper deliberately
  leaves a due step alone, the backup runs it after the lag. That is no new
  power: anyone may call these steps; the backup only guarantees somebody
  does.
- Every setting is bounded: lag 10 minutes to 7 days, run window 10 minutes
  to 1 day, at most 50 loans and 30 days per check, probe gas 100,000 to
  5,000,000, at most 4 runs per perform. A step bit beyond the last step is
  refused.

## Operating it

1. Deploy with `DeployKeeperBackupUpkeep.s.sol` (owner from
   `KEEPER_BACKUP_OWNER`; the treasury is read from the Diamond). It records
   `keeperBackupUpkeep` in the chain's `addresses.json`. Every step is off.
2. Register a custom-logic upkeep for it with Chainlink Automation and fund it
   with LINK. This is an on-chain action that spends LINK, so it waits for
   Raaj's OK per chain.
3. The owner calls `setForwarder` with the upkeep's forwarder, then arms steps
   with `setEnabledSteps`, one decision per step, as each keeper pass ships
   disarmed.
4. Watch `BackupDueNoted` and `BackupStepRun`: a note means our keeper was
   late by the lag; a run means it stayed late. Either is worth an ops look.

Costs: notes and runs are paid in LINK by the upkeep. A check that finds
nothing costs nothing on-chain. A step our keeper runs on time costs the
backup at most one note, when a check happens to see it due before our keeper
gets to it, and never a run.

## Tests

`contracts/test/KeeperBackupUpkeepTest.t.sol` drives the contract against a
stand-in Diamond: every step off at deployment, the simulation-only check,
the probe that changes nothing, note then run only after the lag, a drop
when the keeper ran first, even during the wait (and a drop refused while
still due), a costly part that cannot starve the others, costly loans that cannot hide
the later ones in their page, a disarmed
note dropped, a noted loan revisited after the window moved on, a stale note restarting the wait, a reverted run
recorded with its selector, the forwarder gate, no run without a ready note,
the run cap, the no-sale default with a paid bonus swept to the treasury,
day zero, the recent day window and the rotating history window, the recycle rule, the offer-linked teardown,
the beacon steps and the rotating loan window.
