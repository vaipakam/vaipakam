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
started, spent its whole budget, failed, and finished nothing.

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

Two of the ten jobs were *not* switched off by configuration, so
stopping the schedule does stop them, and an earlier draft of this note
wrongly said the change cost nothing:

- **The daily price snapshot.** It was deliberately left outside the
  keeper's kill-switch, precisely so that turning the keeper off for an
  unrelated reason would not leave gaps in the price series. Stopping
  the schedule leaves exactly those gaps. It is mitigated by the fact
  that anyone can perform this snapshot — it is not restricted to the
  keeper — so the series can be kept whole by any other party in the
  meantime.
- **The pre-grace warning.** Borrowers approaching their grace boundary
  stop receiving the heads-up that lets them repay in time.

Both resume the moment the schedule does.

## What it does not change

Nothing about what the keeper *is*. No job was deleted, no
configuration was cleared, and the switch that arms the fund-moving
jobs is untouched and still off. When the underlying work is done, the
schedule goes back and the keeper resumes every task it had before.

The re-enabling steps are written where the schedule is defined, next
to the empty list, rather than in a separate document that could drift
away from it — including how to confirm from the live logs that the
jobs are finishing rather than being cut off, which is the check that
was missing when this problem went unnoticed.

Part of #1896, which stays open for the underlying work.
