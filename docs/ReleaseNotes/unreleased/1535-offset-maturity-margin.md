## Thread — The offset exit no longer fails at the maximum it offers (#1535)

Leaving a loan by becoming a lender yourself asks how long the
replacement should run, and offers a maximum. Choosing that maximum
failed. The transaction was rejected, nothing was posted, and the
message said the replacement terms did not meet the lender's
requirements — which reads as though the terms were unfair, when in
truth they were a few seconds too long.

The protocol requires the replacement to finish no later than the
original loan would have, and measures that to the second, from the
moment the transaction is actually mined. The form measured it in whole
days, from the moment the page was read. Rounding down to whole days
looks like it leaves room to spare, and nearly always does — but when
the remaining term is an exact number of days it rounds to the loan's
own length and leaves none at all. That is the state of a loan opened
moments ago, which is exactly when someone reaches for this exit.

The offered maximum now keeps an hour in hand, and the check made just
before sending keeps the same hour, since even that check reads a block
older than the one the transaction lands in. Shorter terms were never
affected. The offered maximum drops by a day only when the remaining
term sits within an hour of a day boundary.

Worth recording how long this hid. The test that exercises this exit
was written when the exit was built, but the browser-level test suite
had been broken since before then for unrelated reasons, so the test had
never once run against a healthy setup — it had never passed, and there
was no way to notice. It failed on its first real run. The arithmetic is
now covered by its own tests that check the bound against a local copy
of the protocol's rule, including the precise case that shipped broken.
