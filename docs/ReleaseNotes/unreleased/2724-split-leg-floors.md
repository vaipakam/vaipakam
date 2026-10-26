## Thread — every split-liquidation leg carries its own floor (PR #TBD)

A split liquidation sells a loan's collateral over two or more routes the
caller chooses, in one transaction. Until now only the combined output was
held to the oracle-derived floor; each leg ran with no floor of its own. The
caller writes each leg's route, so one leg could pay its output to an
address of the caller's choosing while an honest leg delivered enough to
cover the whole floor by itself. The diverted proceeds were never booked,
and the lender, the borrower and the treasury lost them.

Every leg is now floored at its own share of the floor: the floor scaled to
the collateral that leg sells, rounded up, and measured at the Diamond, the
same way a single-route sale is measured. A leg below its share reverts the
whole split, so no leg can deliver less than the floor rate on what it sells,
and a split pays the loan at least what one route at the floor would have.
The combined floor is still checked. This is in the one shared split routine,
so it covers every caller of it. It means a keeper that splits a sale must
pick legs that each clear the floor rate, not just legs that clear it
together.

Closes #2724.
