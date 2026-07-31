## Thread — reward claims can no longer spend the recycle pool's backing (PR #TBD)

The protocol holds one pool of its own reward token that two separate
books draw on: the recycled pool, which is topped up by fees the
platform absorbs, and the scheduled reward allocation. A claim that mixed
the two was subtracting only its recycled part from the recycled book
while paying the whole amount out of the shared holding — so a claim
whose scheduled part had no funding behind it could quietly be paid out
of the tokens reserved for recycled payouts.

Nothing was ever paid to the wrong person and no value left the
platform. What broke was the truthfulness of the books: the recycled
pool would go on reporting a balance it no longer held, and the failure
surfaced much later, on some unrelated recycled claim that could not be
funded — as far from its cause as a symptom can land. The reconciliation
tooling could not see it either, because it reads the recorded figures
rather than the actual holding.

Claims now check, before paying anything, that the scheduled part of a
payout fits within the holding that is not already backing the recycled
pool. Where it does not fit the payout is reduced to the amount that is
genuinely funded, and the shortfall is announced so an operator can see
that a deployment is running thin — the recycled component is never
reduced, because its backing is set aside by construction. Where no
scheduled backing remains at all the claim is declined outright with a
message that says so, rather than being paid as zero: a zero payout
would still have consumed the claimant's accrued entitlement and closed
it out, which is a worse outcome than being asked to come back once the
funding arrives. The decline is deliberately distinguishable from the
separate case where the fixed lifetime allocation has genuinely run out,
because an operator's response to the two differs — one resolves itself
when funding lands, the other never does.

Two long-standing gaps that let this go unnoticed are closed alongside
it: an internal note that claimed the protection was already in force
now names where it actually applies, and the test suite now proves the
two books stay separate across a claim that really moves tokens. The
only test that had covered this ground exercised a claim that paid out
nothing, which cannot demonstrate the property at all.

One imprecision is recorded rather than papered over: a third, smaller
reservation within the same holding has no running total to subtract, so
the check is a safe upper bound on what is genuinely free rather than an
exact figure. It is the same bound the two pre-existing checks use.
