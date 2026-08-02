## Thread — day zero was not a day (#1504)

Absorption credited before the reward schedule starts had nowhere to go, so it went to day 0. Genuine first-day credits landed in the same place. The published day-0 figure was therefore the sum of an arbitrarily long pre-launch period **and** the programme's first real day, with no way to separate them.

That is worse than an odd-looking data point, for two reasons.

The pre-launch period has no fixed length — value accumulates there for as long as it takes to reach launch — so day 0 can dwarf every real day and distort any chart, average, or window that includes it. And the figure feeds the trailing absorption average the programme uses to size each day's recycled budget. That average is a **mean daily rate**; the pre-launch figure is a **stock**. Folding one into the other inflated the earliest budgets for a full window on value no single day produced.

Pre-launch credits now accumulate in their own place, readable on its own, and day 0 means the first scheduled day and nothing else.

**Nothing about the value changes — only where it is attributed.** The tokens are in the recycling balance either way, and every backing, availability and cumulative figure is identical before and after. Several of the tests assert exactly that, because a fix that quietly dropped value would be considerably worse than the defect it replaced. The new figure is published rather than merely excluded: it explains the difference between the balance and the day series, and a reader reconciling the two needs to see it.

**The announcement had to change too, and which shape it takes was the real decision.** Leaving the existing notice saying "day 0" while the value was stored elsewhere would have put the announced and stored versions in disagreement — the exact divergence the platform's own rules are written to prevent, and it would have left the new indexer bucketing pre-launch value into day 0 after the contracts stopped doing so.

Three shapes were available, and the choice was made on **how each fails for a reader that has not been updated**. A special day number puts a magic value into a field several consumers iterate as a day. An added flag is silently absent when unread, and absent reads as *day 0* — which reintroduces the very defect. A separate notice is simply not recognised, so the value is **omitted**. Omission understates the series; the other two inflate it. For a transparency figure the conservative failure is the only acceptable one, and a test asserts that the old notice is not emitted for a pre-launch credit — the property that makes the omission real rather than assumed. It also spares the existing notice a second change of shape so soon after the last one, which would have needed its own cutover and its own historical backfill.

The new notice deliberately carries no day at all. There is no day to name, and a field that always reads zero invites exactly the attribution this change removes.

**Two near-identical places were found and deliberately left alone.** The same pre-launch handling appears on the custody-relocation and consumption notices. Neither writes a day-keyed total, so the day there is a label on a notice rather than an attribution feeding the average or the published series, and pre-launch consumption additionally requires an armed governor, which requires a running schedule. Changing them would have widened this fix on the way past. Both now carry a note saying why they differ and what would justify revisiting them, so the difference does not read as an oversight.

**What the fix cannot do:** it does not rewrite credits already taken. A deployment upgraded in place keeps whatever its day-0 figure already holds. On a fresh deployment — the current posture — day 0 is correct by construction. The published caveat is scoped to say so rather than claiming more than the change delivers.
