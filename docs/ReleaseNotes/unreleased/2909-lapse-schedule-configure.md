## Rewards — the deploy now sets the zeroed-day lapse schedule (PR #TBD)

A fresh canonical reward chain used to launch with no lapse schedule at all.
That is the schedule's version 0, under which a zeroed day never lapses and
compensation for it has no dispatch cutoff, so the lapse terminals that #2911
made live from deploy had nothing to act on until an admin remembered to call
the setter by hand. No deploy or configure script did.

The reward-mesh configure step now sets it on the canonical chain, right after
it wires the mirrors: a day lapses seven days after it is finalized, and manual
compensation for it must be dispatched at least 24 hours before that. Both
values can be overridden per run, inside the contract's own bounds. Re-running
the step with the values already in force creates no new version, so the
append-only version history only grows when the schedule actually changes. A
mirror chain is unaffected; it never reads a schedule.

Launch readiness, the single list of launch requirements that the launch
script, the post-deploy verify phases and the on-chain launch gate all read,
gains a check for it. On the canonical chain a missing schedule is NOT MET and
blocks launch, and the readout names the version and both values when one is
set. On any other reward role the check says it does not apply and why.

Closes #2909.
