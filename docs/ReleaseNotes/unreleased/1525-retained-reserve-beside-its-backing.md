## The retained reserve, published only alongside the tokens behind it (#1525)

The public recycling account already showed where each day's reward pool came from and how much was drawn. It did not show the one figure people most want from a reserve: **how much the platform has retained** — and, deliberately, it showed nothing rather than showing that figure alone.

The reason is the difference between this number and every other number on the page. All the others are computed from the platform's own internal counters. A counter is a record of what *should* have happened, and it cannot notice that the tokens it describes have since left. A reserve figure derived that way can report perfect health over an account with nothing in it, and a reader has no way to tell.

So the reserve is published **beside the token balance actually held**, and the two travel together or not at all. If the platform cannot read the live balance, it does not fall back to the counter-derived half — it publishes neither, and says why. A reserve on its own is exactly the confident, checkable-*looking* number this requirement exists to prevent.

Three figures now appear: what the platform has retained, the VPFI it actually holds, and how much of that holding is earmarked for nobody. The third is what makes the first checkable.

**Two details that are easy to get subtly wrong, and were:**

The retained figure nets out both value already promised to users *and* the share set aside to pay for permissionless upkeep. That second term is carved from inside the same balance without reducing it, so a reserve that nets only the first is correct exactly while the upkeep share is switched off, and begins overstating silently the day it is switched on.

The figure is floored at zero. The subtraction can genuinely go negative — that is what a shortfall looks like — but a negative reserve rendered on a public page reads as a display bug rather than as the problem it is. The balance published beside it is what makes that state visible instead, which is the whole reason the pair exists.

Reading the live chain also introduces a way for the page to fail that the rest of it does not have. That failure is contained: the day-by-day account comes from the platform's own records and stays readable, and only the reserve block reports itself unavailable — with the reason, since a blank reads as zero and zero is the opposite of *we could not check*.

**Two of the figures were, on their own, capable of misleading.**

The "balance outside the pool" number is floored at zero. That means a pool the platform has exactly spent down and a pool it is genuinely *short of* display the same value — the ambiguity is built into the figure rather than being a fault in it. A page showing only that number publishes the healthy and the broken state identically, which is the one distinction the whole block exists to draw. So the page now answers the question directly: whether the pool is fully backed, and if not, by how much it falls short.

That same number was also labelled "not earmarked for anyone", which claimed more than it can support. It sets aside one kind of commitment, not all of them — value the platform is holding on a user's behalf is still counted inside it. Describing that as belonging to nobody would tell a reader the platform has more freely available than it does. It is now described as what it is: the balance sitting outside the recycled pool.

**And a set of failures that would have leaked or misled rather than simply degraded.** The error text from a failed chain read carries the address the platform reads from, and those addresses carry provider credentials — so the reason published to every caller is now a fixed code, with the detail kept in the platform's own logs. The read is bounded well inside the browser's own limit, because an unbounded one would have taken the whole page down instead of just this block. Requests for the same chain share a single upstream read, so a public page cannot be used to exhaust the platform's own quota. And the read now confirms it is talking to the chain it thinks it is: an endpoint pointed at the wrong network answers perfectly well, and would have published another network's reserve under this one's name.

