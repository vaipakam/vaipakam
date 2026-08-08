### The worked examples in the documentation were computing fees at the old rates

The platform's two fees were raised some time ago — the fee on lender yield from
1% to 2%, and the fee charged when a loan starts from 0.1% to 0.2%. The
documentation's headline sentences carry a reference to the shipped figure rather
than a number typed into each of ten translations, so they said 2% and 0.2%
correctly. The worked examples underneath them did not: they still did the
arithmetic at the old rates.

The examples are now recomputed at the current rates, and the percentages that
were written out by hand in the surrounding prose have been replaced with the
same reference, so the next retune cannot separate them again. What cannot be
handled that way is the arithmetic itself: a total like "you receive 1,006.44" is
derived from a rate and has to be recalculated by hand whenever the rate moves.
That is now written down as something the documentation owes.

### Those references were not reaching the reader at all

While correcting the numbers we found that the references themselves had stopped
working. The documentation markdown marks a referenced figure with a small token,
and the renderer's test for "is this a token" had been written against a
behaviour the markdown library removed in an upgrade. The test could never be
true, so every referenced figure — the fee rates, the VPFI tier thresholds, the
discount percentages — reached the reader as the raw token text rather than as a
number, on every documentation page, in every language.

The renderer now recognises the tokens again, and it does so by asking the one
question that matters (is this span exactly one token) rather than by
re-deriving what kind of code span it is, which is what went stale.

Worth being precise about what these figures are, because the old wording
overclaimed: on the public marketing site they are the values shipped with the
build, not values read from the chain. That site deliberately holds no wallet
connection and reads no protocol state. The benefit is that a rate lives in one
place instead of ten — which is exactly the drift that caused this — but a
marketing page is only as current as its last deploy, and nothing in the copy
should tell a reader otherwise.

### A second arithmetic error, older than the rate change

Checking the arithmetic turned up a defect that predates the rate rise and was
present in every language. The example showed the lender receiving the repayment
minus a figure that was actually the yield fee **plus** the loan initiation fee —
but the borrower had already paid that initiation fee at the start of the loan,
and the example said so three paragraphs earlier. The lender was being charged it
a second time on paper.

Both the lender's total and the treasury's are corrected, and they are now the
figures the settlement code actually produces: the protocol works from the
unrounded interest, so the example states the unrounded figures too and says
plainly that the displayed amounts are rounded to the cent. A reader who checks
the sum and finds it a cent out now has the answer on the page instead of a
reason to doubt it.
