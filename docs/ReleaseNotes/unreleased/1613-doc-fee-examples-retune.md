### The worked examples in the documentation were computing fees at the old rates

The platform's two fees were raised some time ago — the fee on lender yield from
1% to 2%, and the fee charged when a loan starts from 0.1% to 0.2%. The
documentation's headline sentences were already reading the live figures from the
chain, so they said 2% and 0.2% correctly. The worked examples underneath them
were not: they still did the arithmetic at the old rates.

This had been invisible while the live figures rendered as raw placeholder text.
Once those started resolving, a reader met the correct rate in one sentence and a
calculation contradicting it in the next — in all ten languages.

The examples are now recomputed at the current rates, and the percentages that
were written out by hand in the surrounding prose have been replaced with the
same live figures, so the next retune cannot separate them again. What cannot be
made live is the arithmetic itself: a total like "you receive 1,006.45" is
derived from a rate and has to be recalculated by hand whenever the rate moves.
That is now written down as something the documentation owes.

Checking the arithmetic turned up a second error, older than the rate change and
present in every language. The example showed the lender receiving the repayment
minus a figure that was actually the yield fee **plus** the loan initiation fee —
but the borrower had already paid that initiation fee at the start of the loan,
and the example said so three paragraphs earlier. The lender was being charged it
a second time on paper. Both the lender's total and the treasury's are corrected,
and the numbers a reader adds up on the page now reach the total the page states.
