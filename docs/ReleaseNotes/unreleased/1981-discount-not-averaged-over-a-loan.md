## Thread — What the VPFI fee discount actually measures, said correctly (PR #<n>)

Holding VPFI reduces the fees you pay. How that reduction is worked out was
described wrongly in several places: the documentation said your discount was
averaged across the life of each loan you were in. That averaging was removed
some time ago, and nothing in the fee calculation had used it since. The
documents kept describing it anyway.

**The promise those documents made is still true; only the explanation was
wrong.** They all said the same thing in the end — that topping up your
balance shortly before a loan closes gains you nothing. It does not, and under
the rule actually in force it gains you even less than the old explanation
implied.

Here is what really decides your rate. Your tier is a time-weighted average of
what you held over a recent window — at most thirty days, and never reaching
back before your current run of holding began — the day your balance first
rose above zero and stayed there — with the latest days counting for more.
Adding to a balance you already have does not move that starting day, so a
top-up does not wipe your earlier days from the average or reset anything. That average is then pushed down to the lowest tier you dropped to at any
point since your current holding began — a separate look-back, reaching back
up to thirty days, not the averaging window just described — using each day's
low rather than its closing figure, so a dip counts even if you top back up
before the day ends. And none of it
applies at all until you have held a balance above zero, without interruption,
for a minimum number of days — that clock starts when your balance first goes
above zero and restarts only if it returns to zero, so adding to a holding you
already have neither resets it nor has to serve it again. Both the window and that minimum are settings
the protocol can adjust within fixed bounds. The rate is then read at the
moment a fee is charged.

The two look-backs are separate, and the second is usually the longer. The
averaging window can be set shorter than thirty days; the lowest-tier
look-back is not tied to it and spans your whole current holding, up to thirty
days. So a dip can still hold your tier down after it has left the average.

Against the thing both designs were guarding — a deposit made shortly before a
loan settles — this is the stricter arrangement. An average over a loan can be
dragged upward by a large late deposit; a lowest-value rule cannot be dragged
anywhere. Anyone who reads the corrected text and concludes that particular
move is now easier has read it backwards.

It would be wrong to say the new rule is stricter in every way, and an earlier
draft of this note did say so. Because the lowest-tier look-back reaches back
at most thirty days, a long loan's early low-tier months eventually stop
counting, where an average across the whole loan would have kept them. The
change strengthened the defence against a late top-up and shortened the
memory.

**Where the wording was wrong, and where it was right.** Most references to
time-weighting in the documentation are correct — the tier genuinely is
time-weighted — and only the claim that the weighting ran across a loan's own
duration was false. Correcting this therefore could not be done by replacing a
phrase; each occurrence had to be read where it stood. Corrected: the project's
own contributor handbook, the whitepaper's section on the accumulator, the
overview page and the advanced user guide in all ten languages, and the
glossary. Left alone: the basic guide, which never made the claim, and the
administrative reference, which was accurate.

The architecture decision record that chose the original design keeps its text
and gains a note saying what superseded it. Release notes, archived documents
and past findings are likewise untouched. Those are records of what was decided
or observed at the time, and editing them to match today would be falsifying
them rather than correcting them.

Two internal function names that claimed to perform the removed averaging were
renamed to say what they do. This changes nothing observable — the names are
not part of any published interface — but they are the likeliest reason the
error survived as long as it did: a reader checking the name rather than the
body would have concluded the documentation was right.

Finally, worth recording because it is the encouraging part: the functional
specification, which is the document that defines what the platform is
*intended* to do, never carried the error. It said all along that the discount
applied must equal the rate in force at the moment the fee is charged, and that
figures captured when a loan opens must not drive it. The specification was
right and the material derived from it drifted — the opposite of the failure
that process is usually guarding against.
