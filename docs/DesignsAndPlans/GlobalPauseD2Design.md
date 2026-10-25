# Global pause under owner decision D2 (#668, #935)

Status: implemented in the PR that closes #668 and #935.

## The decision (owner, 2026-10-20)

- **Stays open** under a global pause: repay and add-collateral, so a
  borrower can always lower their risk.
- **Pauses**: new positions (offers, accepts, matches), claims,
  withdrawals, liquidations and defaults.
- **Time credit**: the paused time is added to every open loan's due date
  and grace period, so no loan defaults or is liquidated because of a pause.

## What the code did before

Every exit path carried `whenNotPaused`, so a global pause froze repay and
add-collateral as well. A loan's due date and grace end were computed at
about twenty-five call sites as `startTime + durationDays × 1 day` (plus
`gracePeriod(durationDays)`), and nothing knew whether the protocol had
been paused in between. A pause that outlasted a grace window therefore
let anyone default the loan the moment it was lifted. The unpause sits
behind the Timelock, so a pause lasts at least 48 hours.

## Design

### 1. One record of every pause: the pause-interval log

`LibPausable` keeps an append-only log of paused intervals in its own
namespace, as `(start, end, pausedBefore)`, where `pausedBefore` is the
total paused time before `start`. `end` is a timestamp, or open while a
manual pause is in force.

- `pause()` opens an interval. If an auto-pause window is still running,
  it reopens that interval rather than starting a second one.
- `unpause()` closes the open interval (or cuts a running auto-pause
  window) at `now`, and emits `PauseIntervalClosed(start, end,
  pausedTotal)`.
- `autoPause(d)` appends a closed interval `(now, now + d)`. That interval
  ends on its own; nothing has to be sent when it lapses.

From the log, `pausedSecondsAt(t)` is the total time the protocol was
paused before `t`. It is a binary search over the log, so its cost grows
with the logarithm of the number of pauses, never linearly.
`pausedSecondsBetween(a, b)` is the difference of two such reads.

An earlier option stamped a pause-clock snapshot on each loan. It was
rejected because it needs a new `Loan` field and a stamp at every site
that writes `startTime`. It also could not credit loans opened before the
change. The log needs neither: a loan's credit comes from what the loan
already records, its `startTime`.

### 2. One loan clock: `LibLoanClock`

Every deadline a loan has is read through one library:

| Reading | Meaning |
| --- | --- |
| `pauseCredit(loan)` | paused time between the loan's `startTime` and now |
| `maturity(loan)` | `startTime + durationDays × 1 day + pauseCredit` |
| `graceEnd(loan)` | `maturity + gracePeriod(durationDays)` |
| `periodEndAt(loan)` / `settleAllowedFromAt(loan)` | the periodic-interest checkpoint and its grace end, each shifted by `pauseCredit` |

Every site that used to compute `startTime + durationDays × 1 day` reads
`maturity(loan)`, and every grace-end site reads `graceEnd(loan)`. The
late fee is charged from `maturity`, so a borrower pays no late fee for
days the protocol was paused. `calculateLateFee` and
`calculateRentalLateFee` now take the loan and work out its maturity
themselves; no caller passes an end time any more.

The credit is the paused time since the loan **started**, so the loan's
whole schedule moves together. A pause during the grace period extends
the grace period. A pause that comes after a loan was already defaultable
also extends it, so after the unpause the loan is back inside its grace
window for as long as the pause lasted. That is deliberate. The decision
gives every open loan the credit, and the alternative would favour
whoever triggers the default fastest after an unpause.

Interest is unchanged: it accrues by elapsed time, pause included. Repay
stays open during a pause, so a borrower who does not want that interest
can repay.

Three readings follow from that, and each has one helper:

- **The interest term moves; the accrual does not.** A rate shortfall at a
  sale or an early close (preclose, offset) is priced over the remaining
  term, and that term ends at the moved maturity. `interestTermEnd(loan,
  at)` is the interest clock's start plus its remaining days plus the
  paused time since that start; `remainingInterestSeconds` reads it. A
  partial that re-stamps the clock consumes only unpaused days
  (`unpausedDaysSinceInterestStart`), so the clock never loses the moved
  days. A partial liquidation re-stamps against `maturity`, which already
  carries the credit.
- **A periodic settlement pays one interval.** The period's deadline
  (`periodEndAt`) moves with the credit, but its expected interest is one
  interval's worth, which covers one interval of elapsed time. The
  lender's paid-through mark is therefore the unmoved period end
  (`deliveredThroughAt`), so the paused stretch stays unpaid and a later
  sale still forfeits it.
- **A rental's paid use does not move.** Rent, like interest, is charged
  by elapsed day, pause included, so the prepaid days run out on the
  original schedule. The renter's ERC-4907 expiry is the original maturity
  and the daily deduction closes the rental when the prepaid days are
  used. The credit moves only the rental's late-fee and default
  deadlines, so a renter is never charged a late fee or defaulted because
  of a pause. A loan's `startTime` is reset when the loan is extended in
place or its obligation is handed over (Preclose). The credit then counts
only pauses after the new start, which matches the new term.

### 3. Gating

`repayLoan`, `repayPartial` and `addCollateral` drop the global pause
check. They keep the per-asset pause rules they already had, the
reentrancy guard and the Tier-2 sanctions rule. Everything else stays
paused. That includes:

- `settlePeriodicInterest` and `autoDeductDaily`, which are keeper-driven
  and can catch up after the unpause;
- swap-to-repay (both modes) and the intent flow, which sell collateral
  through external routes. An incident is often in exactly that path. A
  borrower can still repay from their wallet;
- `precloseDirect` and the other Preclose and Refinance routes, which
  open or hand over positions;
- `partialWithdrawCollateral` and every claim.

Any internal step that repay or add-collateral reaches through a
self-call must not carry `whenNotPaused` of its own, or the open route
would still revert. The tests repay and add collateral under a pause to
prove the path end to end.

### 4. Disclosure

- `getLoanDeadlines(loanId)` returns the original maturity, the pause
  credit, the effective maturity and the effective grace end. An off-chain
  reader therefore never has to recompute a deadline that a pause has
  moved.
- `getPauseIntervals(from, count)` pages the log, and `PauseIntervalClosed`
  announces each closed manual interval. An auto-pause interval is
  announced by the existing `AutoPaused` event, which carries its end.
- The `LoanInitiatedDetails.dueTimestamp` an indexer stored at
  origination is the ORIGINAL due date. After a pause it is stale, and the
  view above is the source of truth. The off-chain consumers follow in
  #2808, described below.

#### Off-chain consumers (#2808)

The off-chain side computes deadlines by ONE rule, `@vaipakam/lib/loanClock`,
which mirrors `LibLoanClock` over a copy of the pause log: the paused time
before a moment, the credit between two moments, a loan's original and
effective maturity and grace end, a periodic period's unmoved end and its
deadline, and the credit stated in words. No Worker or app computes
`startTime + durationDays * 1 days` as a current deadline.

- **The log is read once and shared.** The indexer's config refresh reads
  the whole log (`getPauseIntervals`, paged at one block) beside the grace
  schedule and stores both in `protocol_config` (migration 0072,
  `pause_intervals_json`). It refreshes on every pause event, and a refresh
  that cannot read the log clears the column rather than keep a log the
  event has made stale. `@vaipakam/lib/loanClockSnapshot` is the one reader
  of that row. It answers either both inputs or an unknown with its reason:
  no row, a column unread, a value that does not parse, or a database
  ahead of the migration.
- **A Diamond without the loan clock** does not route `getPauseIntervals`.
  Its `FunctionDoesNotExist` is read as an empty log, definitively, because
  such a Diamond never moves a deadline. Every other failure is an unknown.
  Nothing falls back to the original dates on a failed read.
- **The indexer's loan routes** add `deadlines` to every Active loan: the
  original maturity, the credit, the effective maturity and grace end,
  whether a pause is in force, and the instant they were computed for. When
  the inputs are unknown the routes serve `available: false` with the
  reason, never the original dates.
- **The calendar reminders** window on the effective maturity, and their
  dedup key embeds it, so a pause that moves a loan's maturity re-arms its
  milestones for the new date. The window query still filters on the
  original maturity's expression index first, widened by the largest credit
  any loan could have. The sweep holds while a pause is in force, or while
  the log is unknown or damaged, because the maturity is still moving.
- **The swap-to-repay grace end** the indexer stores is read from the
  contract (`getPrepayContext`), which already includes the credit.
- **The agent's periodic-interest reminders** read the log at the same
  head as their other reads, in one request, and refuse a log longer than
  that request returns instead of truncating it. Their window and the date
  they name are the period's deadline. The dedup stamp, the eligibility
  check and the resume key stay on the period's unmoved end, which is the
  period's identity and does not move under a pause between ticks. A
  reminder whose deadline a pause moved says by how much and why. The
  extra read costs every chain one more request per tick, so a tick reaches
  one loan fewer before its allowance runs out; the reminder window is days
  wide, so a deferred loan is reached on a later tick.
- **The keeper and the app** follow in their own changes: the keeper's
  pre-grace and default checks, and the app's loan pages, which state the
  original date, the credit and the reason.

### 5. What the credit does not cover

- Offer, intent, sale-listing and Seaport order expiries are not loan
  deadlines and are not moved. Such an order can expire during a pause,
  and the user posts it again.
- A rental's ERC-4907 user expiry, as above: the prepaid use ends on the
  original schedule.
- HF liquidation needs no credit. It is paused while the protocol is
  paused and resumes after the unpause.
- A parallel-sale listing's price floor is set before the loan exists and
  hedges interest only up to the ORIGINAL grace end. After a long pause, a
  fill late in the extended grace window could accrue more interest than
  the floor covers. That fill is refused (`ProceedsBelowLenderTreasury`),
  so the lender is never short-paid. The borrower can still repay, or post
  the listing again at a higher price.

## Deployment

Every facet that reads a loan deadline is in this change. A partial
refresh would leave some facets on the old clock, which would make the
default, repay and late-fee views disagree. So the change reaches a chain
only through `RefreshAllFacetsInPlace` or a fresh deploy. The two curated
refresh scripts, `RedeployFacets` and `ReplaceStaleFacets`, refuse a
Diamond from before it (`PredatesLoanClock`). The marker is the routing of
`LoanFacet.getLoanDeadlines`. The log is new
storage appended to the pause namespace, so the storage-layout guard
records it. A chain upgraded in place starts with an empty log, and a
pause that ended before the upgrade is not credited. A pause the pause
flags still record is: a manual pause in force at the upgrade (upgrades
run under the manual pause), or an auto-pause window set before it,
running or lapsed. One rule in `LibPausable` reads that pause as the
interval it will be stored as, starting at the last pause boundary the
namespace already stamps (`lastPauseBoundaryAt`) and never before the end
of the last stored interval (#2809 r1). Every reader counts it from the
moment of the upgrade, so a loan's credit runs during the inherited pause
and repay stays open against the moved deadlines before anyone unpauses;
the interval log view reports it as its last entry. Every writer (pause,
unpause, auto-pause) stores it first, unchanged, before it moves the
boundary or clears the flags, so the credit is the same before and after
it reaches storage and never moves backwards.
