### #597 — reserve held-for-lender VPFI against the unstake path

When a lender's obligation is transferred or offset to a new offer mid-loan, the
amount owed to that lender is parked in their vault as a "held-for-lender"
balance and paid out later when the position holder claims. Previously, when
that held balance was in VPFI, nothing stopped the lender from immediately
unstaking it back out of their vault before the claim — so a departing lender
could withdraw funds that were already earmarked for whoever holds the position.

This change reserves those held-for-lender VPFI balances against the unstake
path the moment they accrue, exactly like the lender's proceeds on a normal
loan close are already reserved. The reserved amount is invisible to the
"withdraw my staked VPFI" path until the position holder claims it.

Because a loan can change hands, the reservation follows the funds:

- On obligation-transfer and offset, the loan keeps its lender, so the
  reservation simply sits with that lender until claim.
- When a lender sells the loan to a new lender, the held VPFI physically moves
  to the new lender's vault, and the reservation is re-keyed to the new lender
  in the same step — so the old lender can never unstake it on the way out, and
  the new lender's claim is fully backed.

No change for non-VPFI held balances (only VPFI has a user-facing unstake path)
and no change for loans that never accrue a held-for-lender amount.
