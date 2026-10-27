## Thread — Docs and user guide state the live fee and the current sale and refinance outcomes (PR #2967)

The functional spec still described the loan initiation fee as 0.1%, with a worked example of 1000 USDC becoming 999 USDC. The fee has been 0.2% since the rev-8 fee freeze, which is the rate the tokenomics spec and the admin knobs page already state. Every statement of the live rate and both worked examples now say 0.2% (1000 USDC becomes 998 USDC when the borrower has no fee discount).

The advanced user guide, in all ten languages, said a refinance burns the old loan's position NFTs. It does not: the old loan is marked repaid and both of its position NFTs stay with their holders, marked Loan Repaid. The old lender claims the repayment with theirs, and the old borrower NFT stays as a receipt. The guide now says so.

The same guide still described the collateral sale as it worked before the neutral-sale change (#2916): the lender paid inside the sale and the borrower's remainder deposited into their vault with no claim. A sale now closes the loan as a repayment. The lender's due waits in the lender's vault for the ordinary lender claim, the treasury takes its share net of any lender discount, and the rest goes to the borrower-position holder's wallet, or is held for the borrower claim if it cannot be paid to that wallet. The sale section, the borrower actions list and the note on a repay that loses the race to a sale now say this; the translated editions carry the sale section and the atomic-match outcome, which are the parts they already had.

Closes #2943.
