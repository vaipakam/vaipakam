## Thread — The mesh watcher takes its cadence from its schedule alone (#3144)

The mesh watcher reads one chain per run, in rotation. Which chain a run reads
used to depend on two numbers that had to agree: the schedule, and a separate
"seconds between runs" setting. If they ever disagreed, the rotation could stop
moving without any error. With the schedule at every fifteen minutes and the
setting still at five, every run landed on the same chain, and the other two
went unwatched. This was seen once on 2026-11-04, when one run fired on the old
fifteen-minute schedule while the new one was taking effect. It was harmless
then because it happened only once.

The separate setting is gone. Each run now works out its step from its own
schedule, so there is only one number. The rotation accepts schedules of every
minute, or every N minutes where N divides an hour evenly, because only those
fire at even spacing. Any other schedule makes the run fail and raise an alert
naming the schedule, instead of quietly watching some chains and never others.

A manual run without a chain id still picks a chain from the clock, in
five-minute slots. It only chooses which chain to show and never moves the
alert windows.

> Caveat: The live Worker still carries the retired setting as a dashboard
> variable, because deploys keep dashboard variables. Nothing reads it any
> more. Delete it from the dashboard when convenient.

Closes #3144.
