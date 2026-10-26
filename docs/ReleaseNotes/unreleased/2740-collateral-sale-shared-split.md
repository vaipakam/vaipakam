## Thread — A collateral sale settles as a repayment does (PR #2891)

A loan closed by selling its collateral (a prepay or parallel marketplace
listing, or a swap-to-repay intent fill) now owes exactly what a full
repayment at the same moment would owe, and splits it the same way. The
lender receives principal plus interest net of the treasury's cut, and the
treasury receives its cut of that interest. Before this change the sale legs
paid the lender its whole interest and charged the treasury's cut on top, out
of the borrower's remainder, so selling cost the borrower more than repaying.
Every listing floor, fill-time check and payout now reads one split, the one
repayment settles with, so a floor and the payout it protects cannot disagree.

A sale that lands after the due date but inside grace is a late repayment and
now owes the late fee, which the treasury takes its usual cut of. Before, a
borrower could sell inside grace and skip it. A listing whose legs are fixed
for a later moment (a Dutch listing fixes them at the auction's end) prices
interest and the late fee at that moment. A borrow-or-sell listing posted
before a lender accepts hedges the most the debt can reach before the grace
boundary: worst-case interest over the term and grace, plus the late fee at
the boundary. It no longer adds a treasury charge on top. The swap-to-repay
intent fill also stops checking the same floor twice, since its payout refuses
any delivery below that floor.

Two consequences are stated rather than implied. The lender now bears the
yield fee on the two marketplace sale routes, as on a repayment, so the
lender's yield-fee discount should apply there and does not yet: the
loan-keyed listing pays its treasury leg to the treasury inside the
marketplace fill, before the platform can shift any of it. That is dark until
a lender has discount consent or a Full stamp, and it is now a named item on
the fee-entitlement cut-over blocker (#2876). And fixed-price listings signed
before maturity go stale at maturity because the late fee starts then; the
borrower re-signs with the live amounts, as they already must when a day's
interest accrues.

Closes #2740.
