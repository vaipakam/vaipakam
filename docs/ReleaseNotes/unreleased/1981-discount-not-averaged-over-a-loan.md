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
what you held over the last thirty days. That average is then pushed down to
the lowest tier you dropped to at any point in the same period, using each
day's low rather than its closing figure — so a dip counts even if you top back
up before the day ends. And none of it applies at all until you have held your
current balance for a minimum number of days. The rate is then read at the
moment a fee is charged.

That is a stricter arrangement than the one described before, not a weaker one.
An average over a loan can be dragged upward by a large late deposit; a
lowest-value rule cannot be dragged anywhere. Anyone who reads the corrected
text and concludes their discount is now easier to game has read it backwards.

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
