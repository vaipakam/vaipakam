# The next app adds collateral to a loan

A running loan's page in the next app now offers its borrower a way to add collateral. Only the holder of the borrower position may do this, so the action is shown to that holder alone. It is held, with the reason, while a swap-to-repay order on the borrower position is pending, when governance has paused the collateral token, and when the protocol does not price the collateral token now; the two token checks are read live, not from the loan's class when it opened. A rental has no collateral to add to. The protocol pause never holds a top-up, since a borrower can always lower their risk, and the review says so in every case.

The borrower types how much more of the loan's own collateral token to add, checked against the wallet's balance as it is typed. The review shows the collateral now and after, that it is held in the borrower's vault locked to the loan, and the loan's health factor and loan-to-value now. No protocol view gives the figures a top-up leads to, so the review says the finish card will show the protocol's own. It also says that added collateral can be taken back only within the protocol's limits while the loan runs, and that a loan in fallback returns to running only if the top-up restores the protocol's opening limits.

The protocol takes exactly the amount chosen, so a standing approval that already covers it is left as it is, and a smaller one is raised to exactly the amount and put back if the top-up does not go through.

After the top-up the app reads the outcome from the transaction's own record: the collateral it left, the protocol's health factor and loan-to-value after it, whether a loan in fallback returned to running, and what left the wallet.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-POSITION-ADD-COLLATERAL. Epic #3180.
