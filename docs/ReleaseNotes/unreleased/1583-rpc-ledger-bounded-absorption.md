## Live-review tooling — a failed RPC read can no longer be excused by an unrelated later one (PR #TBD)

The live-review drivers watch every RPC call the deployed page makes and
end the run non-zero when a read was never served, so that a page which
merely *looks* right cannot pass while it was quietly running on failed
data. Because the RPC client retries internally and the app lists several
endpoints as fallbacks, the driver deliberately forgives a failure that a
later attempt recovered — otherwise a perfectly healthy page would report
as blocked.

That forgiveness was too broad. Attempts are matched by method and
parameters, which is not the identity of a single invocation: the page
polls for the current block continuously, so every one of those polls
shared an identity, and any later poll succeeding would clear an earlier
read that had genuinely exhausted its retries and surfaced a failure to
the page. A run that was incompletely served could therefore finish clean.
True invocation identity is not recoverable from what the driver observes —
retries look exactly like independent calls on the wire, and simultaneous
duplicate reads are indistinguishable by content — which is why the issue
had been deferred as unfixable at this layer.

What *is* recoverable is when each attempt arrived, and that turns out to
be the missing discriminator. One logical operation's retries are seconds
apart at most, while the app's repeat polls of the same read are most of a
minute apart, so the two live on clearly different scales. The driver now
groups a read's attempts into operations by elapsed time and lets a success
excuse only failures it could actually have shared an operation with. An
unrelated later poll can no longer reach back and clear an earlier chain
that died, however many endpoints were involved.

Within one operation the driver additionally forgives only as many failures
as a single operation could physically spend, and that ceiling now counts
the retry the data layer performs on top of the transport's own — omitting
it made the allowance too small, so a read that exhausted the transport and
then succeeded on the outer retry was reported as a failure even though the
page had its data.

An earlier revision of this change tried to do the whole job with that
count alone, sizing the allowance from how many endpoints appeared in the
ledger. Review showed a count is unsound in both directions at once: it can
be inflated by any independent invocation that happens to answer on another
endpoint, yet still be too small to cover the outer retry — and distinct
endpoints in the ledger never established that one fallback operation had
traversed them. Time bounds the window first; the count now only applies
inside it.

Where a group genuinely cannot be decomposed — simultaneous duplicate reads
really are identical on the wire — the driver forgives rather than reports.
For tooling that gates releases, a false alarm that trains people to ignore
it is worse than a missed degradation, and the case that actually proves a
run was incompletely served (a read that never succeeded at all) is caught
without needing to tell those duplicates apart.

Closes #1583. This tightens a verdict, so a live drive may now report
failures on a run that previously passed — those are real findings that
were being absorbed, not new faults.
