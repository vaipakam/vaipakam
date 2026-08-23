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
offset can only complete if the replacement loan it creates would finish by the
original loan's end date. Past a certain point no acceptance can ever succeed
again — so the offer sits there unfillable, still blocking, and still removable
only by the person who has stopped responding. This is not hypothetical: a
pending offset in exactly that state was found on the test network, three weeks
old, against a loan that had ended a fortnight earlier.

A pending offset now carries a deadline, and giving it one is what fixes the
freeze — because it puts the offer back under a rule the platform already had.
An offer past its deadline can be cleared out by anyone, not just the person who
posted it, and clearing it releases the borrower's position, drops the link to
the loan, and returns the borrower's own posted funds to the borrower, exactly
as their own cancellation would have. A lender no longer has to wait on a
borrower who has gone quiet, and nobody gains anything by doing the clearing.
The borrower keeps their unconditional right to cancel at any point before the
deadline.

The deadline is set at the moment the offer stops being acceptable, and that is
**earlier** than the loan's end date — earlier by the length of the replacement
the offer proposes. Because the replacement loan starts when the offer is taken
up, an offer proposing a three-week replacement stops being takeable three weeks
before the loan ends, not when it ends. Anchoring the deadline at the loan's end
date would have left the offer unusable but not yet lapsed for exactly that
span, with the freeze running on through it — and for an offer proposing the
loan's entire remaining term, that span is the whole term, meaning the fix would
have done nothing at all in the case that needed it most.

One consequence is worth stating because it looks odd and is correct: an offset
proposing a replacement exactly as long as the loan's remaining term can only be
taken up in the instant it is posted. That is not the deadline being harsh — it
is the existing replacement-term rule shown honestly, rather than hidden behind
an offer that looks open but can never be taken. A borrower who wants a usable
window proposes a shorter replacement, and gets a window exactly as long as the
difference. Posting the full-term one is still allowed; what would be wrong is
refusing to create it, which is where an earlier attempt at this deadline went
astray.

Nothing about the replacement-term rule itself changes. Whether a replacement
would really run past the original end date is still decided when the offer is
accepted, measured against the moment the replacement actually starts. The
deadline neither replaces that check nor tightens it.

Closes #1814.
