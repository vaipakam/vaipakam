## A lender offer past its deadline can no longer be consumed by a direct position sale

An offer to lend carries a deadline. Past it, the offer is dead everywhere it
can be filled or matched — the row survives in storage because nothing sweeps
it away, so every path that could bind it to a loan is expected to refuse it
on sight.

One path did not. A lender selling their position directly into a standing
offer to buy went through checks on what kind of offer it was and whether it
had already been taken, but never on whether its deadline had passed. So an
offer whose window had closed, and which nobody had yet got around to
cancelling, stayed consumable: the seller could take the principal the offer's
author had set aside and mark it as filled, after the period that author
agreed to had ended.

Nothing here was mispriced. The author got exactly the loan they described, at
their stated terms. What they did not get was the right to stop offering — the
deadline they set was the whole of their consent to the timing, and it was
being read by every other route and ignored by this one.

The sale now refuses an offer past its deadline, before anything moves. The
caller is told which offer expired and when, so the refusal can be explained
rather than just reported.

Two details worth stating, because both are places a fix like this commonly
goes wrong:

**An offer with no deadline is not an expired offer.** Offers may be authored
to stand until cancelled, recorded as the absence of a deadline. A check
written as "now is at or past the deadline" reads that absence as the earliest
possible instant and rejects every such offer. The sale routes through the
shared helper that already handles this, rather than re-deriving the rule.

**The deadline second is already closed.** An offer good until a given moment
is not fillable *at* that moment. This matches every other fill path, and is
now pinned by its own test so a later simplification cannot quietly reopen a
one-second window.

This is one of the contract-side gaps recorded against the lender
early-withdrawal work. It was the one that moved another party's funds outside
the window they consented to, and the guard it needed already existed and was
already in use elsewhere — it had simply never been called here.
