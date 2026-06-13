## Thread — NFT-rental preclose now charges the rental fees to the borrower's prepay, not the caller's (#574)

When an NFT rental is closed early (preclosed), the protocol settles the
full-term rental: it takes a treasury fee and the lender's rental income
out of the rental **prepay** the borrower posted up front, and leaves the
unused remainder claimable by the borrower.

Until this change, both of those deductions were taken from **whoever
called** the preclose, not from the borrower who actually posted the
prepay. That was harmless when the borrower closed their own rental (the
caller and the borrower are the same), but wrong the moment anyone else
triggered it — which the design explicitly allows: a keeper authorised for
the preclose action, or someone the borrower position was transferred to.
In those cases the deduction either failed outright (the caller has no
prepay of their own to take) or, worse, pulled the fees out of the caller's
own funds. The rental prepay lives in the original borrower's vault for the
life of the loan regardless of who closes the rental, so that is where the
fees must come from.

This change sources both the treasury fee and the lender's rental share
from the **borrower's** prepay vault. Closing a rental on someone's behalf
(keeper or transferred-position holder) now settles correctly from the
right place, and no one's personal funds can be pulled by a preclose they
trigger. Borrower-closed rentals are unaffected. The unused-prepay refund
was already recorded against the borrower and is unchanged.

This was the one remaining place a borrower-owned fund movement keyed on
the transaction caller instead of the stored borrower. A sweep of every
collateral- and prepay-moving path confirmed the rest already source and
sink against the borrower of record; this brings the preclose rental path
in line. Closes #574.
