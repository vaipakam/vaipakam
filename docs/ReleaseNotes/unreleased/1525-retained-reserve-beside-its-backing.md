## The retained reserve, published only alongside the tokens behind it (#1525)

The public recycling account already showed where each day's reward pool came from and how much was drawn. It did not show the one figure people most want from a reserve: **how much the platform has retained** — and, deliberately, it showed nothing rather than showing that figure alone.

The reason is the difference between this number and every other number on the page. All the others are computed from the platform's own internal counters. A counter is a record of what *should* have happened, and it cannot notice that the tokens it describes have since left. A reserve figure derived that way can report perfect health over an account with nothing in it, and a reader has no way to tell.

So the reserve is published **beside the token balance actually held**, and the two travel together or not at all. If the platform cannot read the live balance, it does not fall back to the counter-derived half — it publishes neither, and says why. A reserve on its own is exactly the confident, checkable-*looking* number this requirement exists to prevent.

Several figures now appear together: what the platform has retained, the VPFI it actually holds, how much of that holding is labelled as recycled runway, how much sits outside that label, and a plain answer to whether the recycled pool is fully backed — with the size of any shortfall. The balance is what makes the reserve checkable; the plain answer is there because the numbers alone cannot distinguish a pool that has been exactly spent down from one that is short.

**Two details that are easy to get subtly wrong, and were:**

The retained figure nets out both value already promised to users *and* the share set aside to pay for permissionless upkeep. That second term is carved from inside the same balance without reducing it, so a reserve that nets only the first is correct exactly while the upkeep share is switched off, and begins overstating silently the day it is switched on.

The figure is floored at zero. The subtraction can genuinely go negative — that is what a shortfall looks like — but a negative reserve rendered on a public page reads as a display bug rather than as the problem it is. The balance published beside it is what makes that state visible instead, which is the whole reason the pair exists.

Reading the live chain also introduces a way for the page to fail that the rest of it does not have. That failure is contained: the day-by-day account comes from the platform's own records and stays readable, and only the reserve block reports itself unavailable — with the reason, since a blank reads as zero and zero is the opposite of *we could not check*.

**Two of the figures were, on their own, capable of misleading.**

The "balance outside the pool" number is floored at zero. That means a pool the platform has exactly spent down and a pool it is genuinely *short of* display the same value — the ambiguity is built into the figure rather than being a fault in it. A page showing only that number publishes the healthy and the broken state identically, which is the one distinction the whole block exists to draw. So the page now answers the question directly: whether the pool is fully backed, and if not, by how much it falls short.

That same number was also labelled "not earmarked for anyone", which claimed more than it can support. It sets aside one kind of commitment, not all of them — value the platform is holding on a user's behalf is still counted inside it. Describing that as belonging to nobody would tell a reader the platform has more freely available than it does. It is now described as what it is: the balance sitting outside the recycled pool.

**And a set of failures that would have leaked or misled rather than simply degraded.** The error text from a failed chain read carries the address the platform reads from, and those addresses carry provider credentials — so the reason shown to a reader is a fixed code, with the detail kept in the platform's own logs. The read confirms it is talking to the chain it thinks it is: an endpoint pointed at the wrong network answers perfectly well, and would otherwise have published another network's reserve under this one's name. And a reading that stops being refreshed is withheld rather than served indefinitely — a figure that quietly freezes while claiming to be minutes old is the same false confidence in slower motion.

One figure needed its name changed after a closer look at what the underlying counter does. Value released from the recycled pool is recorded permanently — if the transfer later goes through after all, the recipient gets it but the counter is deliberately never wound back. Calling that row "sent but not yet delivered" would therefore become untrue the moment a delayed release completed, and stay untrue. It now says what the counter actually measures: value released from the pool and never credited back to it.

The two chain reads behind this section are also pinned to a single block. They exist to explain each other — the second is what stops released value looking like a depleted reserve — and read independently, a release landing between them produces exactly the misleading pair the second read was added to prevent.

**A note on how this is read from the chain, because the first design was wrong in an instructive way.**

The reserve and the balance behind it were originally read from the chain *while answering each request for the page*. That sounds like the freshest possible answer and it is, but it couples a blockchain round trip to a browser request — and every consequence of that coupling then has to be solved separately: the read has to finish before the browser gives up, or it takes the rest of the page down with it; simultaneous *and* consecutive visitors have to be prevented from each spending a call against the same quota the platform's own indexing depends on; that prevention has to work across the many isolated instances serving the page; and each visitor waiting on a shared read needs their own time limit. Each of those was fixed, and each fix produced the next problem.

None of them exist if answering the page does no network work at all. The platform already reads the chain on a schedule, so the reserve is captured there and the page serves what was stored.

The cost is that the figures trail the chain, and **the page now shows the timestamp of the state they describe**. How far they trail depends on how many chains the platform is reading — captures rotate one chain at a time — so the page states the timestamp rather than promising an interval it cannot keep at every size. If the reading falls further behind than the rotation should allow, or the chain it came from stops advancing, the whole section is withheld rather than shown as current.

That disclosure is the part I originally had wrong: I justified serving a not-quite-live figure on the grounds that its age was published, when it was only present in the underlying data and never shown to anyone. A disclosure a reader cannot see is not a disclosure. For a question like *do the tokens behind this reserve exist*, a reading somewhat behind the chain answers it perfectly well — but only if the reader can tell how far behind it is.

