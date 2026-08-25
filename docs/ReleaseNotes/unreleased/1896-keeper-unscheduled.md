# The keeper is deployed but no longer scheduled

The keeper Worker has been removed from its every-minute schedule. It is
still deployed, and everything it needs to work is still in place — the
code, the database binding, all seventeen secret and configuration
bindings. Bringing it back is a matter of restoring one line, not
rebuilding anything.

## Why

It had not been completing its work for at least as long as the
platform's logs go back. Measured against the live deployment, roughly
every single invocation was being terminated for exceeding its CPU
allowance, and had been continuously. So each minute the Worker
started, spent its whole budget, and was cut off before finishing.

That is not the same as achieving nothing: several of its jobs did
complete before the invocation died, and may well have sent alerts or
written records first. What is certain is that every minute ended in
termination rather than in an orderly finish, indefinitely.

*Which* of its ten jobs consumed that budget is not yet known. An
earlier draft of this note named two of them; that was inference rather
than measurement, and it has been withdrawn. The jobs are started
concurrently, so a job with no completion line may equally have been
waiting on a network response when the whole invocation was cut off.
Finding the real answer needs profiling inside the jobs, and is part of
the work this note does not finish.

It also returns a scheduling slot to a pool that was completely full.
The platform's plan allows only five scheduled jobs across the whole
account, and a previous deployment failed outright on that limit.

## What it does cost

**Four** of the ten jobs were not switched off by configuration, so
stopping the schedule stops them for certain. Two earlier drafts of
this note got this wrong in turn — the first said the change cost
nothing, the second named only half of them:

- **Health-factor alerts to users.** The largest loss, and the one both
  earlier drafts missed. The watcher keeps evaluating positions and
  keeps messaging borrowers even while the keeper's own actions are
  switched off. Stopping the schedule stops those messages: a borrower
  drifting toward liquidation is no longer told.
- **The daily price snapshot.** Deliberately left outside the keeper's
  kill-switch, precisely so that turning the keeper off for an
  unrelated reason would not leave gaps in the price series — so
  stopping the schedule produces exactly the gaps that choice existed
  to prevent. Mitigated by the fact that anyone can perform this
  snapshot; it is not restricted to the keeper.
- **The pre-grace warning.** Borrowers approaching their grace boundary
  stop receiving the heads-up that lets them repay in time.
- **Liquidity-confidence state.** Its switch governs only whether it
  submits on-chain; it still reads and still records. Stopping the
  schedule stops that record advancing at all.
- **Cleanup of expired Telegram link codes — found during review, and
  fixed here rather than accepted.** The only thing that removed them
  ran inside the watcher. The part that *issues* those codes is a
  different service that stays running, so the stop would have left
  them handed out and never cleared — short-lived codes that should
  expire in minutes staying on record, with the table only growing.
  That cleanup now also runs on the service that issues the codes,
  which is where it belonged: that service already tidies its own
  records on the same schedule, and the sweep is a single bounded
  delete. The keeper keeps its copy, so nothing is lost when it comes
  back; running twice is harmless. This one is therefore **not** a cost
  of the stop any more.

**Six more stop conditionally**, and whether they were running cannot
be determined from outside. The matcher, the liquidator, the
auto-lifecycle pass, reward-budget remittance, its acknowledgement
pass, and the commitment report all sit behind the master switch. If
that switch was on before this change, unscheduling stops all six as
well; if it was off, they were already idle. Since the switch's value
cannot be read back — the same limitation stated further down — **plan
for the case where they were running**: matching, liquidation and
reward funding must be treated as unavailable for the duration rather
than assumed to be someone else's job.

**They do not resume the instant the schedule returns, and some losses
do not resume at all.** A restored schedule can take up to a quarter of
an hour to take effect everywhere. The daily snapshot then waits for
its next daily window, and the pre-grace warning for its next turn in
the rotation. Days of price history missed in the meantime are **not
backfilled** — the contract records only the current day.

Pre-grace warnings divide in two, and an earlier draft of this note got
it wrong by treating them as one. A loan whose repayment date has
already passed by the time the schedule returns is never warned about —
that warning is simply lost. But a loan that is *still* within its
warning window when the keeper comes back **is** warned then, just
late. So the return of the schedule can bring a burst of overdue
warnings rather than silence, and borrowers may get less notice than
the window is meant to give them. Expect both, and treat a long stop as
something to announce rather than to let people discover.

## What it does not change

Nothing about what the keeper *is*. No job was deleted and no
configuration was cleared. The switch that arms the fund-moving jobs
is untouched — and untouched is all that can honestly be said about
it: its value is stored in a form that cannot be read back, so nobody
can confirm from the outside whether it is on or off. That is why the
re-enabling steps begin by setting it off explicitly rather than
assuming, and it is why restoring the schedule out of band, without
that first step, must not be treated as safe. When the underlying work
is done, the schedule goes back and the keeper resumes every task it
had before.

The re-enabling steps are written where the schedule is defined, next
to the empty list, rather than in a separate document that could drift
away from it — including how to confirm from the live logs that the
jobs are finishing rather than being cut off, which is the check that
was missing when this problem went unnoticed.

Part of #1896, which stays open for the underlying work.
