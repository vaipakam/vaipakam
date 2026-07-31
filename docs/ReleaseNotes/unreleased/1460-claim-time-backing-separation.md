## Thread — reward claims can no longer spend the recycle pool's backing (PR #TBD)

The protocol holds one pool of its own reward token that two separate
books draw on: the recycled pool, topped up by fees the platform
absorbs, and the scheduled reward allocation. A claim that mixed the two
was subtracting only its recycled part from the recycled book while
paying the whole amount out of the shared holding — so a claim whose
scheduled part had no funding behind it could quietly be paid out of the
tokens reserved for recycled payouts.

Nothing was ever paid to the wrong person, and no one was paid more than
they had earned — but value did leave protocol custody, because the
tokens that funded the payout were the ones earmarked as the recycled
pool's backing. What broke was the truthfulness of the books: the
recycled pool would go on reporting a balance it no longer held, and the
failure
surfaced much later, on some unrelated recycled claim that could not be
funded — as far from its cause as a symptom can land. The reconciliation
tooling could not see it either, because it reads the recorded figures
rather than the actual holding.

Claims now check, before paying anything, that the scheduled part of a
payout fits within the holding that is not already backing the recycled
pool. A claim that does not fit is declined, and the message says how
much was needed against how much was free.

Declining rather than paying a reduced amount is the deliberate part,
and it is worth explaining because the platform does reduce payouts
elsewhere. The fixed lifetime allocation may be shrunk to fit, because
once that allowance is spent it never grows back — the part that could
not be paid was never going to be payable, so nothing is lost by
settling the claim for less. Backing is the opposite: it is replenished
every time funding arrives. Since pricing a claim also uses up the
entitlement behind it, paying a reduced amount there would quietly
delete the remainder that was about to become payable — turning a
book-keeping fault into a real loss for the claimant. Declining keeps
the entitlement intact, and the same claim pays in full once funding
lands. That is also what the specification already promised for a chain
awaiting funds: recoverable back-pressure, never lost value. This was
checked rather than assumed — an experiment that reduced a payment,
restored funding and tried again found nothing left to claim.

The decline is deliberately distinguishable from the separate case where
the fixed lifetime allocation has genuinely run out, because an
operator's response to the two differs: one resolves itself when funding
lands, the other never does.

Two long-standing gaps that let this go unnoticed are closed alongside
it: an internal note that claimed the protection was already in force
now names where it actually applies, and the test suite now proves the
two books stay separate across a claim that really moves tokens — and
that a declined claim loses the claimant nothing. The only test that had
covered this ground exercised a claim paying out nothing at all, which
cannot demonstrate either property.

One imprecision is recorded rather than papered over: a third, smaller
reservation within the same holding has no running total to subtract, so
the check is a safe upper bound on what is genuinely free rather than an
exact figure. It is the same bound the two pre-existing checks use.
