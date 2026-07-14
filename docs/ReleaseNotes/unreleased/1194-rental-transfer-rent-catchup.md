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
rewritten to the new borrower, the protocol now forwards to the current
lender-position holder — funded from the exiting borrower's prepayment, exactly
as the normal daily deduction does — two amounts: the rent accrued between the
last daily deduction and the transfer (minus the usual treasury cut), and, when
the incoming borrower's term is shorter than the exiting borrower's remaining
term, the rent for the pre-paid days the new borrower won't cover (the "term
shortfall", which goes to the lender in full, matching how the interest-loan
path already compensates the lender for a shorter replacement term). Only
in-term rent is settled (rent past the agreed maturity is a late-fee matter
handled elsewhere), and the total is bounded by the prepayment actually on hand.
Everything left in the exiting borrower's prepayment after that — their
genuinely unused prepay and buffer — remains theirs to withdraw. The incoming
borrower's own prepayment and buffer take over the loan from the transfer
forward.

Two edge cases are handled explicitly: the settlement runs only for true
zero-rate rentals, so a (mis-configured) rental carrying an interest rate is
left to the interest path and never billed twice for the same window; and a
rental whose deduction clock has been pushed into the future by an earlier
prepayment can still be transferred without the elapsed-rent calculation
underflowing.

The result: the original lender is no longer economically disadvantaged by an
obligation transfer on a rental, matching the protection the platform already
gives lenders on interest-bearing loans and the intended behaviour that the
exiting party pays all rent accrued up to the transfer. Interest-bearing
transfers are unchanged. Closes #1194 (Pass-2 conformance umbrella #1196).
