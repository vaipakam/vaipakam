# The next app repays a loan in full

A running loan's page in the next app now offers to repay it in full. Anyone may repay a loan except its lender, so the action is shown to the borrower and to any other wallet, and left out for a reader who holds only the lender side. It is held, with the reason, once the grace period has ended (the loan then goes to default), while a swap-to-repay order is pending on the borrower position, and for a rental, which this page cannot repay yet. A lender's sale listing, a refinance request and the protocol pause never hold it. A loan in fallback stays repayable, since repaying cures it.

What a repayment costs grows by the second, and the protocol takes the figure as of the moment the repayment confirms. So the review shows two of the protocol's own figures: what it costs now, and what it would cost about thirty minutes ahead, never later than the end of the grace period. The second figure is read by asking the protocol for that moment, and the app checks that the connection really answered for that moment. The wallet approves exactly the later figure. The review says that a repayment confirming after that moment is refused with nothing moved, and that whatever the repayment does not use of the approval is put back afterwards. A wallet that does not hold the borrower position is told that paying gives it no right to the collateral. A refinance request posted for the loan is named too: the repayment ends it, but its offer stays posted until it is cancelled.

After the repayment the app reads the outcome back from the chain: the loan repaid, what left the wallet (which must lie between the two figures), and the unused approval put back to what it was before.

Paying part of a loan, adding or taking back collateral and the other loan actions come in later updates.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-REPAY. Epic #3180.
