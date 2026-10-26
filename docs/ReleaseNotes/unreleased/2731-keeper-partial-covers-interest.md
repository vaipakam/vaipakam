# Keeper: a partial liquidation refused for not covering interest is resized, not dropped (#2731, #2886)

A partial liquidation now has to pay at least the interest the loan has
accrued since its interest clock last started. A slice that falls short is
refused by name, because the clock restarts at a partial and the shortfall
would otherwise be written off at the lender's expense.

The keeper treats that refusal like its other "slice too small" answers. The
refusal states what the slice repaid and how much interest is due, so the
keeper sizes the next slice straight to cover it, at the rate the refused slice
paid, still inside the band the other refusals leave it. If that is still
short, the protocol refuses again and the keeper keeps growing the slice. Only
when no partial size can both cover the interest and stay under the
over-liquidation ceiling and the close-factor cap does it move on to the split
or full liquidation. Before this, the keeper did not recognise the refusal, so
it skipped the loan and recomputed the same slice on the next run.
