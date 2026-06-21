### #661 — reserve a borrower's VPFI default surplus against the unstake path

When a loan is liquidated or defaults and the collateral is worth more than the
debt, the leftover surplus is returned to the borrower's vault and paid out
later when the position holder claims it. Previously, when that surplus was in
VPFI, nothing stopped the borrower from immediately unstaking it back out of
their vault before the claim — so a borrower who had transferred their position
could withdraw funds that were already earmarked for whoever holds the position.

This change reserves the VPFI surplus against the "withdraw my staked VPFI" path
the moment it lands, exactly like the lender's proceeds are already reserved on
a close. The reserved surplus is invisible to the unstake path until the current
borrower-position holder claims it, at which point it is released and paid out
atomically. It is wired on every path that can return a surplus — time-based
default and both the standard and split liquidations.

No change for non-VPFI surpluses (only VPFI has a user-facing unstake path) and
no change for loans that close with no surplus.
