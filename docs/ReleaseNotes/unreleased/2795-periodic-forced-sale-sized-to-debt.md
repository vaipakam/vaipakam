## Thread — periodic auto-liquidation sells only what the missed interest needs (PR #2811)

When a periodic-interest payment is missed and the protocol sells collateral
to cover it, the sale is now sized to what is owed: the missed interest plus
the handling charge and the caller's incentive, both taken on that debt (2%
and up to 3% of it), at the worst price the slippage limit allows. The lender
is paid at most what was owed. Whatever the sale raises beyond that belongs to
the borrower: it goes to the borrower-position holder's wallet in the same
transaction, or, when that holder is flagged or the wallet payment cannot be
completed, it is held in the borrower's vault and paid with the borrower's
claim when the loan ends. If the borrower position is handed over to a
replacement borrower first, the held amount is paid to the exiting holder
along with their released collateral. Before this change the sale used a fixed
buffer and the lender was credited with everything above the charges.

The borrower's claim now pays each of its parts on its own flag (remaining
collateral, held proceeds, a pending fee rebate) and refuses only when all of
them are paid or empty, so an extra held earlier in the loan is still paid
when the loan later ends with nothing of the collateral left for the
borrower; the lender's claim no longer settles the loan while it is unpaid.
The app's claim list follows the same rule. When an obligation handover moves
VPFI out of the exiting borrower's vault, their VPFI standing is refreshed.

The rule lives in one place, a new forced-sale facet that sizes the sale,
sells it through the usual swap failover and splits the proceeds lender first.
Every figure of each sale is published in one new event (debt, the amount the
sale had to raise, collateral sold and left, proceeds, and each share), and the
periodic auto-liquidation event now names the borrower's share and whether it
was held. The old slippage notice is gone, since the lender is no longer
credited with a shortfall the sale did not cover. The other forced sales
(Health-Factor liquidation, the time-based default and partial liquidation)
move onto the same facet in follow-up work (#2796).

Deployment note: the new facet is refreshed together with RepayPeriodicFacet,
PrecloseFacet, EncumbranceMutateFacet and the facets that consolidate a
position. Closes #2795.
