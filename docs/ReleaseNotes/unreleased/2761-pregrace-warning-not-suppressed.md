# Pre-grace warning: no offer in the book silences it any more (#2761)

The keeper warns a borrower who has auto-refinance turned on when their loan
is within a day of its due date and has not been refinanced. It used to skip
that warning whenever any lender offer in the book matched the loan's asset
pair and could cover its principal. That check ignored the offer's expiry,
duration, remaining capacity, rate and collateral terms, so an offer that would
never fill still silenced the warning, and anyone could post such an offer to
switch a borrower's warning off.

The keeper no longer reads the offer book for this pass. Every opted-in loan
inside the warning window gets the warning, throttled as before. A borrower
whose loan is about to be refinanced anyway may get a warning they did not
need; that costs them little, while a warning missed can cost them their
collateral. The pass also makes fewer reads per run.
