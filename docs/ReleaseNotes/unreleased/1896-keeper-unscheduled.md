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
allowance, and had been continuously. Two of its ten jobs consumed the
entire allowance between them and were cut off part-way through, every
minute, while the other eight were already switched off by
configuration and returned immediately.

So each minute the Worker started, spent its whole budget, failed, and
finished nothing. Unscheduling it does not make the keeper any less
functional than it already was — it stops a job that was reliably
failing from being started sixty times an hour.

It also returns a scheduling slot to a pool that was completely full.
The platform's plan allows only five scheduled jobs across the whole
account, and a previous deployment failed outright on that limit.

## What this does not change

Nothing about what the keeper *does*. No job was deleted, no
configuration was cleared, and the switch that arms the fund-moving
jobs is untouched and still off. When the underlying work is done, the
schedule goes back and the keeper resumes every task it had before.

The re-enabling steps are written where the schedule is defined, next
to the empty list, rather than in a separate document that could drift
away from it — including how to confirm from the live logs that the
jobs are finishing rather than being cut off, which is the check that
was missing when this problem went unnoticed.

Part of #1896, which stays open for the underlying work.
