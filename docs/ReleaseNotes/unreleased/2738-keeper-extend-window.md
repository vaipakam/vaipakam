# Keeper: auto-extend only near maturity, and never shortens the grace deadline (#2738, keeper half)

The keeper's auto-extend pass used to re-term any loan whose borrower and lender had both switched auto-extend on, as early as a day after it started. Each extension settles the interest so far, restarts the loan's clock and moves its rate to the lender's floor, so a loan could be re-termed long before anyone needed it extended.

The keeper now extends a loan only inside a window that opens three days before its effective due date and closes at the end of its grace period. The due date is read on the loan clock, so a protocol pause that moved it later moves the window too. The keeper also refuses a new term that would make the loan defaultable sooner. A shorter term can carry a shorter grace period, so a new due date that is later than the old one is not enough: the new due date plus its grace must not come before the old due date plus the old grace.

When the keeper cannot read the pause record or the grace schedule, it extends nothing on that chain for the run, rather than judging against a date the chain may not hold the loan to.

The contract does not check either rule yet. The contract half of #2738 will enforce the same window and the same grace rule on-chain, and publish the window, which the keeper will then read instead of holding its own copy.
