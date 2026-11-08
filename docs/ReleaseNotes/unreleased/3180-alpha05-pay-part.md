# The next app pays part of a loan

A running loan's page in the next app now offers its borrower a way to pay part of the loan. Only the holder of the borrower position may do this, so the action is shown to that holder alone. It is held, with the reason, when the loan's terms do not allow paying part (the lender's choice when the loan opened), once the grace period has ended, while a swap-to-repay order is pending, while a refinance request on the loan is live, and while an offset offer on the borrower position is live, because that offer was made for the loan as it stands. A loan in fallback can only be repaid in full, which cures it, and a rental cannot be paid in part on this page yet. The protocol pause never holds it.

The borrower first types how much of the principal to pay. The amount is checked as it is typed against the protocol's own bounds: at least the protocol's minimum part for the lending token, and less than the whole principal, which belongs to Repay in full.

A part payment also pays the interest accrued since the loan's interest was last paid. No protocol view gives that interest ahead of the payment, so the review shows it from the protocol's payoff figure less the principal. On a pro-rata loan before its due date that is exactly the interest, and the review shows it as an amount. Otherwise, on a full-term loan or past the due date, the payoff figure also counts things a part payment does not charge, so the review shows "at most" and says why. This gap is recorded as issue #3299.

The review also shows the principal left afterwards, that the due date does not move, that the lender position's holder is paid straight away with the treasury taking its share of the interest, and that the interest counts toward the current interest period. The wallet approves exactly the most the payment can take, and whatever it does not use is put back afterwards. The borrower can go back and change the amount from the review.

After the payment the app reads the outcome back from the chain: the principal lowered by the part, what left the wallet, where the interest period now stands, and the unused approval put back.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-PARTIAL. Epic #3180.
