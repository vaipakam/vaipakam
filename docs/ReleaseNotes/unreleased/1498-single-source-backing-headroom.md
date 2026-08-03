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

### One half of this is fixed; the other is now stated plainly as open

The above holds for a platform deployed **fresh** under current rules. A
platform **upgraded from an older one** is a different matter, and review
was right to press on it: it can still be holding that VPFI against loans
open at the time of the upgrade. Those tokens sit inside the figure, so a
reward payout can spend them — and the borrower's settlement, when it
eventually comes, is short. It either fails outright or leaves them unpaid.

**That gap is not closed here, and the item tracking it stays open.** What
changed is the diagnosis. It is not really a missing subtraction; it is the
same root as the outstanding cross-chain reward work — payouts are limited by
what the platform *happens to hold spare*, rather than by what was *delivered
to fund rewards*. A running total of held custody would patch one symptom.
Bounding payouts by delivered funding removes both, and that is where the
item now points.

Separately, the collection routine still exists, unused. **Re-connecting it**
would reintroduce the gap on a fresh platform too. An existing test stands in
the way: it funds a borrower, brings them to a qualifying tier, opts them
into the discount, confirms that tier is actually in effect, and only then
asserts nothing is taken into custody. Checking the setup *before* the
conclusion is what makes it a real guard rather than one that would pass
whether or not the routine were live.
