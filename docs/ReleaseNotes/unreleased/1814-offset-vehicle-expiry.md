## A borrower's pending offset can no longer freeze a lender's exit forever (#1814)

When a borrower wants out of a loan, one of the routes open to them is to post
an offsetting offer — they take a lending position of their own that closes out
the one they owe. While that offer is pending, the lender's two early-exit
routes are deliberately refused, because either would start a second settlement
of a loan that already has one in flight and the two would race.

That refusal was meant to last until the offsetting offer either completed or
was cancelled. The problem was that a pending offset had no deadline of any
kind, and only the borrower who posted it could take it back. So the refusal had
no end: a borrower who posted an offset and then simply walked away left the
lender unable to use either exit route, indefinitely.

It is worse than indefinite, because the offer outlives its own purpose. An
offset can only complete if the replacement loan would finish by the original
loan's end date. Once that date passes, no acceptance can ever succeed again —
so the offer sits there unfillable, still blocking, and still removable only by
the person who has stopped responding. This is not hypothetical: a pending
offset in exactly that state was found on the test network, three weeks old,
against a loan that had ended a fortnight earlier.

A pending offset now carries a deadline, and that deadline is the original
loan's own end date. The offer stops being available at the same moment it stops
being completable, so it never advertises a route that could not have settled
anyway.

Giving it a deadline is what fixes the freeze, and it does so by putting the
offer back under a rule the platform already had. An offer that has passed its
deadline can be cleared out by anyone, not just the person who posted it — and
clearing it releases the borrower's position, drops the link to the loan, and
returns the borrower's own posted funds to the borrower, exactly as their own
cancellation would have. A lender no longer has to wait on a borrower who has
gone quiet, and nobody gains anything by doing the clearing. The borrower keeps
their unconditional right to cancel at any point before the deadline.

Nothing about the term rule changes. Whether a replacement loan would run past
the original end date is still decided when the offsetting offer is accepted,
measured against the moment the replacement actually starts. The new deadline
neither replaces that check nor tightens it — a distinction that matters,
because deriving the deadline from the term rule instead of from the loan's end
date would have refused a perfectly legitimate offset posted at the very start
of a loan for its full remaining term. That was the reason an earlier attempt at
this bound was abandoned, and it is why the fix is anchored where it is.

Closes #1814.
