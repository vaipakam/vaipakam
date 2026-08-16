## Handing over an obligation can no longer consume an offer past its deadline

A borrower leaving a loan early may hand the obligation to someone else, by
consuming a standing offer that person had already published saying what they
were willing to borrow and on what terms. That offer can carry a deadline.

The handover never looked at it. It checked that the offer was the right kind,
that nobody had taken it already, that it was not reserved for a different
purpose, that it had not been partly filled, and that its assets matched the
loan — and then bound it. So an offer whose window had closed, and which nobody
had yet cleaned up, could still be used: the departing borrower could hand a
live debt to someone whose stated willingness had already lapsed.

The person on the receiving end is not present when this happens. They
published terms, the window they set passed, and the obligation arrived anyway.
Their deadline was the whole of their consent to *when*, and it was the one
condition the handover did not read.

This is the same gap that was just closed on the lender side, where a lender
selling a position could draw on an offer past its deadline. Both paths reach a
standing offer without going through the ordinary acceptance route, so neither
inherited the deadline check that route performs. Both now refuse, before
anything moves.

Two details, both places a fix of this shape commonly goes wrong:

**An offer with no deadline has not expired.** Offers may be published to stand
until withdrawn, recorded as the absence of a deadline. A check written as "now
is at or past the deadline" reads that absence as the earliest possible moment
and rejects every such offer. Both paths route through the shared helper that
already knows the difference.

**The deadline moment is already closed.** An offer good until a given instant
cannot be taken *at* that instant. Consistent with every other route, and now
pinned by its own test.

A third route was checked at the same time and deliberately left alone: a
borrower refinancing their own loan consumes an offer they authored themselves,
so ignoring the deadline there overrides nobody's wishes but their own.
