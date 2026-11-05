## Interest counts by the second on every path

An ERC-20 loan's interest now counts to the second wherever the protocol settles or values it: full and partial repayment, preclose, refinance, a sale, an extension, swap-to-repay, defaults, liquidations and the health-factor reading. Repayment, preclose, refinance and the partial paths used to count whole days, rounded down. So a pro-rata loan repaid within its first day paid no interest at all, while the same loan's liquidation debt and its extension charge already counted seconds. The owner chose per-second interest on 2026-11-05, rounded down once per settlement, which is how liquidation already rounded. The same loan now owes the same interest at the same second, whichever path settles it.

For a full-term-interest loan settled early nothing changes: a 365-day year in seconds and in days give exactly the same figure, so the borrower still owes the agreed term's interest to the wei. Past maturity, inside the grace period, a full-term loan accrues the time actually elapsed, to the second. The in-place extension's charge now follows the same rule; for a full-term loan it used to stop at the minimum even when more time had passed.

The full-term minimum after a partial repayment, partial swap-to-repay or partial liquidation now runs from the restarted interest clock to the loan's maturity, to the second. It was a whole-day counter decremented at each partial, which dropped the part day before maturity each time. The counter is retired. Its storage slot stays, renamed and no longer written, and the minimum is derived from the loan's start and term. A pause before the restart lengthens the minimum, because it moved the maturity. A pause after the restart moves only the deadlines.

Partial withdrawal now values a loan's debt exactly as the health-factor check does, net of interest already settled periodically. Before, it counted whole days and could differ from it.

Funds: borrowers pay interest for the time they actually held the principal, to the second. The extra interest goes to the lender, less the treasury's usual cut on interest. Nothing else moves. The app's own estimates follow the same rule, and so do the payoff figures the refinance and offset flows reserve. NFT rentals keep their own rule: a part day counts as a whole day.

This changes contract code and a storage field's name, so it reaches a chain only through a fresh deploy. Closes #3169.
