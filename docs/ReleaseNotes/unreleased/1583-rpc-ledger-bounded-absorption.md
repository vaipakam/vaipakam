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

The count, however, is recoverable even when the identity is not. One
logical operation can spend only so many attempts before the client gives
up, so a longer unbroken streak of failures than that ceiling must contain
a read that really did die, regardless of what succeeded afterwards. The
driver now forgives only the tail of a streak that one operation could
plausibly account for and reports the excess, and it sizes that allowance
from the endpoints actually involved — so it widens exactly when a
fallback is genuinely in play and stays tight for an ordinary
single-endpoint poll. Recovered reads are still forgiven, so the earlier
false-blocked behaviour stays fixed.

One related correction: a provider *rejecting* a request is now only
excused when a different endpoint went on to answer it. The RPC client
never retries a rejection against the same endpoint, so a later success
there is the page asking again rather than a recovery, and the rejection
did reach the application the first time. It had previously been treated
the same as a transient outage purely by symmetry.

Closes #1583. This tightens a verdict, so a live drive may now report
failures on a run that previously passed — those are real findings that
were being absorbed, not new faults.
