## One definition of "how much VPFI is free to pay out"

Before a reward is paid, the platform checks that the tokens backing it are
genuinely spare — that paying this reward will not eat the balance set aside
as recycled reward runway. **Two** places enforce that: one refuses a claim
that would overdraw it, and one caps the amount an expiry sweep may take.
Each worked the figure out for itself, even though the library that owns the
underlying ledger already defined it and publishes it as a read-only
transparency figure. The arithmetic agreed. The explanations sitting beside
it did not.

Both now read that single definition. Nothing about what is or is not
allowed has changed; the same claims succeed and the same ones are refused.

### Why the duplication mattered more than it looks

The copies had drifted in their *descriptions*, not their results — and a
description is what the next person acts on. One of them said the figure was
only an approximation, and that making it exact needed a new running total of
a second category of held tokens.

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

### More owners of the same holding kept appearing — and why none are reserved here

Review kept finding the same shape with different owners: the recycled reserve, borrower fee custody on grandfathered
loans, the per-party tariff (already safe — it credits the recycled reserve),
treasury revenue where the platform holds its own, the reward-emissions
budget, the keeper reward budget, collateral held during a live
swap-to-repay, and collateral left in place when a liquidation cannot find a
route to sell it.

Each round of review produced another — and more than once the newest arrived
in the round *after* the list had been written up as complete, which is the
clearest possible statement of the problem.

**The last two change what kind of problem this is.** They are not protocol
budgets; they are a **borrower's collateral**, sitting in the same holding
while their loan is mid-flight. A reward payout that draws on them is
spending money that belongs to a user, so this stopped being a bookkeeping
tidy-up and became a fund-safety item.

One of them **was** reserved during this work, and that change has been
**withdrawn**. Two reasons, and the second is the more instructive.

First, the count. The list grew in every round it was written up as
complete, with no sign of the rate falling, which says the approach itself is
wrong: permitting a payout up to
"everything we hold, minus the claims we remembered to write down" needs that
list to be complete forever, and a missing entry causes no visible failure —
which is exactly how each of these went unnoticed.

Second, patching it made things worse. Reserving that one owner immediately
put the payout rule out of step with the separate rule governing when an
unclaimed reward expires, which still measured the holding the old way. The
result: expiry clocks kept running while every payout was refused, so an
entitlement could lapse without its holder ever having had a usable window to
claim it. A fix that creates a fresh way to lose user value is the point to
stop patching and change approach.

So the remaining owners are recorded as **known and unreserved** rather than
half-addressed, and the figure is documented as an upper bound on genuinely
free tokens — on every deployment, not just unusual ones. Bounding payouts by
*funding delivered for rewards* needs no list at all, covers every owner at
once, and is the same bound the outstanding cross-chain work needs. That is
now the tracked remedy, and new custody should wait for it rather than be
added to a subtraction that cannot be completed.

### One half of the first finding is fixed; the other is now stated plainly as open

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
