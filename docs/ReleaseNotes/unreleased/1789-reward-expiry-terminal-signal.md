## Thread — a reward's expiry always ends with its terminal signal

When the expiry sweep starts removing a reward, it announces the removal,
and it announces the reward's expiry as complete when it finishes. Three
routes ended such a reward without that second announcement. The
accounting was right in each case; what was missing was the record that
the reward had ended.

The first route is a forfeit after removal began. If the loan forfeited
after the sweep's first pass, the forfeit settled the rest correctly but
nothing announced that the expiry had ended. The forfeit's last step now
also emits the expiry's completion signal once, carrying what the earlier
expiry passes actually moved to the recycle bucket. The forfeited
remainder keeps its own forfeit signal, so each destination is still
reported once.

The second and third are empty remainders. A reward whose removal had
begun but whose remaining window turned out to price to nothing, and a
forfeited reward whose remaining window on the post-arming path was
empty, both returned without being marked finished. They moved no value,
but they stayed in the owner's list of unsettled rewards and were scanned
again by every later sweep.

The expiry sweep now retires any reward whose remaining window the
pricing step reports as empty, whether or not its removal had begun,
through the same empty-window retirement the claim path uses, with its
retirement signal. A reward whose removal had begun also gets the
expiry's completion signal. A reward that simply cannot be priced yet,
because its days are not final, is left untouched for a later sweep: only
an empty window is final. The forfeit path's empty remainder is retired
the same way. As on the claim path, a reward's earlier-era slice is first
brought to its settled state before the empty window is retired, so no
half-prepared slice is left behind a retired reward; until it is, the
sweep retries.

No value moves differently. Indexers that treat the completion signal as
the end of an expiry now see every begun expiry end.

Closes #1789
