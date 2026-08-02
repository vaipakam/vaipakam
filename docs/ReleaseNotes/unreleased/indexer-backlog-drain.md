## Indexer — deep backlogs now drain in hours, not days (PR #<n>)

During the July outage recovery, catch-up speed was bounded by the
ingest loop's shape: a routine timer tick asked only "anything new?",
so one bounded chunk of blocks was scanned and the loop parked until
the next five-minute tick — even when hundreds of thousands of blocks
remained. Base Sepolia took ~14 hours to drain a ~340k-block backlog;
Arb Sepolia's ~1.5M-block backlog projected to about a week.

Now, when a scan completes successfully but stopped more than one full
pass-budget short of the chain's safe head, the loop re-arms itself on
the existing 30-second slow lane instead of parking. Only successful
passes qualify — an erroring chain keeps its bounded retry budget, so
this can never turn into a retry storm — and the extra bookkeeping is
one alarm write per draining pass, only while genuinely behind. At the
drain rate this enables, a week-long backlog converges in hours.

The decision runs at the shared completion point of EVERY successful
scan, however it was triggered. A webhook-driven scan already
self-drives toward its known target block; what changes for it is the
tail: where reaching the target used to park the loop uncondition-
ally, a pass that met its target while still more than one full
pass-budget behind the safe head now keeps draining on the same slow
lane. The headline win is the disaster-recovery lane — where no
webhook tells the loop how far behind it is — but operators should
expect the loop to keep consuming its one-alarm-per-pass budget after
ANY trigger while a genuine backlog remains, and to park only once
within a pass-budget of the head. An immediate webhook trigger that
arrives while a drain pass is finishing keeps its immediacy — the
drain re-arm never overwrites an earlier-firing alarm.
