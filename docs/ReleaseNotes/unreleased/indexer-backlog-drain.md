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

The webhook-driven path (which already self-drives toward a known
target block) is unchanged; this fixes specifically the disaster-
recovery lane where no webhook tells the loop how far behind it is.
