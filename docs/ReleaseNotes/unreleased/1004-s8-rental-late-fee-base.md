## NFT-rental late fee now scales with the overdue rent (PR #<n>)

The late fee on an overdue NFT rental used to be computed on a single day's
rental fee, so a renter forty days late on a large rental paid the same penalty
as one a single day late on the same rental — the fee never scaled with the size
of the obligation, contradicting the specification (which has always described
the rental late fee as a percentage of the *overdue rental amount*). This fixes
the code to match: the rental late fee is now based on the rent still owed on the
remaining term (the per-day fee times the remaining rental days), so the penalty
tracks the actual debt. The corresponding repayment-preview quote was updated in
lockstep, so a late-rental repayment preview matches what settlement charges.
ERC-20 loans are unaffected — their late fee was already correct.

The fee is now paid out of the borrower's pre-paid rental *buffer* (the small
safety margin collected up front alongside the rental prepayment) rather than out
of the rental prepayment itself. Without this, a fully-overdue full-term rental —
whose entire prepayment is consumed by the rent owed — could not complete a late
repayment at all, because any positive late fee would exceed the remaining
prepayment. Drawing the fee from the buffer, which exists for exactly this
purpose, lets the repayment always settle; any unused buffer is refunded to the
borrower. The late-fee cap is clamped to the loan's OWN pre-funded buffer amount
(the value snapshotted when the rental was originated), not the live global
buffer setting — so even if governance changes the rental-buffer percentage
between a loan's origination and its repayment, the fee can never exceed what
that specific loan actually pre-funded, and the late close-out cannot brick.

This is one of three deferred #998 spec-conformance findings; its approach was
ratified in the Tranche-5 deferred-trio design doc after three rounds of review.

Closes #1004.
