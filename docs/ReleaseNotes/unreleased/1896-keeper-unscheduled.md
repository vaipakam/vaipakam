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
stopping the schedule stops them. Two earlier drafts of this note got
this wrong in turn — the first said the change cost nothing, the second
named only half of them:

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

**They do not resume the instant the schedule returns, and some losses
do not resume at all.** A restored schedule can take up to a quarter of
an hour to take effect everywhere. The daily snapshot then waits for
its next daily window, and the pre-grace warning for its next turn in
the rotation. Days of price history missed in the meantime are **not
backfilled** — the contract records only the current day — and warnings
that were due while the keeper was stopped are simply not sent late.

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
