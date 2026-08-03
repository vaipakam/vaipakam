## One definition of "how much VPFI is free to pay out"

Before a reward is paid, the platform checks that the tokens backing it are
genuinely spare — that paying this reward will not eat the balance set aside
as recycled reward runway. Three separate places performed that check, and
each worked out the figure for itself. The arithmetic agreed. The
explanations sitting beside it did not.

They now all read the same figure from the single place that owns it. Nothing
about what is or is not allowed has changed; the same claims succeed and the
same ones are refused.

### Why the duplication mattered more than it looks

The three copies had drifted in their *descriptions*, not their results — and
a description is what the next person acts on. One of them said the figure
was only an approximation, and that making it exact needed a new running
total of a second category of held tokens.

That was true when it was written and had since stopped being true. The
category it referred to is VPFI collected from a borrower at the start of a
loan and held until settlement. An earlier change retired the path that
collects it: no loan opened under the current rules hands over any such VPFI,
so there is nothing left to subtract. Acting on the stale note would have
meant adding a running total that could only ever count zero — machinery that
reads as a safeguard while guarding nothing.

The correction is recorded once, at the definition, rather than at each of
the three readers. Restating it three times is what produced the drift.

### What is now written down

All three categories of held VPFI are stated explicitly, along with whether
each is subtracted and why — including one that deliberately is **not**.
Unclaimed reward funding is exactly what a reward claim is entitled to draw
on, so subtracting it would refuse claims their own money. Its place in the
underlying rule says the platform must be *holding* it, not that a payout may
not touch it. That distinction was implicit before and is now stated.

### The two ways the retired category could come back

Both are real rather than theoretical, so both are named:

A platform **upgraded from an older deployment** can still be holding this
VPFI against loans that were already open at the time of the upgrade. For
those, the figure remains an over-estimate of what is free.

And the collection routine still exists, unused. **Re-connecting it** would
start taking that VPFI again. An existing test is what stands in the way: it
funds a borrower, opens a loan, and asserts that nothing is taken into
custody. Reconnecting the routine fails that test — which is the point of
keeping it.
