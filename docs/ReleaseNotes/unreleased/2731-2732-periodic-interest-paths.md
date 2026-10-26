## Thread — every interest payment counts toward the current period, and a periodic settlement can always run (PR #2885)

On a loan with a periodic-interest schedule, the borrower owes each period's
interest by a deadline, and a settlement sells collateral for any part left
unpaid after the grace window.

**Interest a partial liquidation pays now counts toward the period.** A
partial repayment and a partial swap-to-repay already credited the interest
they paid to the current period. A partial liquidation paid interest to the
lender too, but did not credit it, so the next settlement could read the
period as unpaid and sell the borrower's collateral for interest the lender
already had. All three now go through one shared rule, so a new path that
pays interest mid-period cannot leave the credit out.

Two related corrections to the partial liquidation. Interest the borrower had
already paid ahead of the accrual, through an earlier settlement, is now
carried forward against the restarted interest clock instead of being
discarded. And a slice must now pay the interest accrued since the clock last
started in full: the clock restarts at a partial, so interest a short slice
left unpaid would have been written off at the lender's expense. Such a slice
is refused by name, and the keeper sells a larger one or liquidates in full.

**A pending swap-to-repay auction no longer blocks a periodic settlement.**
Before a forced close-out sells collateral it cancels any swap-to-repay
auction the borrower has open. The periodic settlement used the
health-factor check for that cancel, which refuses while the loan is
healthy, so a healthy borrower who missed a periodic payment could keep an
auction open and the settlement would always fail. The cancel now takes the
trigger the close-out acts on and checks that trigger itself: the health
factor for a liquidation, the grace end for a time-based default, and the
unpaid period for a periodic settlement. A close-out whose own trigger does
not hold still leaves the auction its window.

Closes #2731. Closes #2732.
