## Thread — Transferring a rental obligation now settles the rent owed up to the transfer (PR #1194)

The protocol lets a borrower hand a live loan's obligation to a new borrower
(Option 2 / obligation transfer). For an ordinary interest-bearing loan the
exiting borrower must first pay the interest accrued up to the moment of
transfer, so the original lender is made whole for the time they were exposed.
That settlement was computed with the standard interest formula (rate × time),
which is correct for a lending loan but returns **zero for an NFT rental**: a
rental carries no interest rate — its economic payment is a fixed per-day fee
that is deducted from the borrower's prepayment each day. So when a rental
obligation was transferred, the rent that had accrued since the last daily
deduction was never settled to the lender. The transfer then reset the rental's
prepayment accounting to the incoming borrower's terms, quietly discarding that
undeducted rent, which simply stayed in the exiting borrower's (un-liened)
prepayment balance for them to withdraw. The original lender was left short the
rent they had earned right up to the handover.

This change settles that rent as part of the transfer. Before the loan is
rewritten to the new borrower, the protocol now forwards the rent accrued
between the last daily deduction and the transfer to the current lender-position
holder — minus the usual treasury cut — funded from the exiting borrower's
prepayment exactly as the normal daily deduction does. Only in-term rent is
settled (rent past the agreed maturity is a late-fee matter handled elsewhere),
and the amount is bounded by the prepayment actually on hand. Everything left in
the exiting borrower's prepayment after that — their genuinely unused prepay and
buffer — remains theirs to withdraw, unchanged. The incoming borrower's own
prepayment and buffer take over the loan from the transfer forward.

The result: the original lender is no longer economically disadvantaged by an
obligation transfer on a rental, matching the protection the platform already
gives lenders on interest-bearing loans and the intended behaviour that the
exiting party pays all rent accrued up to the transfer. Interest-bearing
transfers are unchanged. Closes #1194 (Pass-2 conformance umbrella #1196).
