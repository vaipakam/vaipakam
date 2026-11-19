# Anyone may pay toward a loan, and the interest can be paid at any time (#3779)

A part repayment of an ERC-20 loan is now open to the same people as a full repayment: anyone who is not on the lender's side. A relative, an employer or a friend can pay toward a loan as well as close it. The collateral, the position and anything the loan releases stay with the borrower position, and the payment's record now names who paid.

A new payment pays the interest accrued so far, at any time inside the repayment window, on any ERC-20 loan. It needs no agreement to part repayment, because it retires no principal. The payer names the most they will pay and the platform takes that or the interest owed at that moment, whichever is less, so nothing is ever taken in advance. A payment of less than the whole interest so far must be at least the asset's smallest part payment. It is booked by the same rule the periodic sale and the payment reserve use, counts once against everything the loan later charges, and counts toward the current interest period, which then closes with no sale of collateral when it is covered.

Payers who are not the borrower position's holder are now screened against the sanctions list on all three wallet payments, the full repayment included. The holder is never refused, so a lender can always be made whole; an outsider owes the lender nothing. This tightens the full repayment on purpose for a flagged outsider.

What an interest period owes is now read from the loan's own record instead of a per-period counter: the interest accrued since the loan's interest clock last restarted, up to the period's end, less the interest already settled. The counter it replaces was priced on the whole period at the principal outstanding at the moment of reading, so a part repayment in the middle of a period could make the period read short by interest the repayment had just paid, or cover it with interest it had not. A payment covering more than one period now closes each, and a part day paid past a boundary counts toward the next one. A pause does not stop the interest; it moves the period's end later, and the period owes for its real length.

Every step that restarts a loan's interest clock now does it through one rule, which charges what accrued less what was already settled and carries anything paid ahead into the new stretch. Two steps had their own versions and are corrected: an in-place extension charged interest already settled by a forced sale or the payment reserve a second time and then left that credit standing against the new term, and an obligation handover cleared interest paid ahead instead of carrying it. A new pre-deploy check refuses any other way of restarting the clock.

The full repayment's record now also states the loan's due date, the moment a late fee starts, so an on-time repayment can be told from a late one directly (#3778).

Design: `RepaymentByOthersDesign.md` (card #3779).
