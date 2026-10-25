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
can repay. A loan's `startTime` is reset when the loan is extended in
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
  view above is the source of truth. The indexer, keeper and app changes
  that consume it are tracked as a follow-up issue, since they are
  off-chain.

### 5. What the credit does not cover

- Offer, intent, sale-listing and Seaport order expiries are not loan
  deadlines and are not moved. Such an order can expire during a pause,
  and the user posts it again.
- A rental's ERC-4907 user expiry is written at origination and again on
  each daily deduction. It is re-read from `maturity(loan)` on the first
  deduction after the unpause.
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
