## Keeper roll pass leaves VPFI intent loans to their owners' claim (#2914)

Lender intents can now lend VPFI (#2914), but auto-roll still refuses a VPFI
loan, because its repayment proceeds stay reserved until the position holder
claims them. The keeper's roll pass now reads the VPFI token once per chain per
run and skips those loans without asking the chain to estimate each roll.

Any other loan the roll refuses because it settles through the normal claim (a
transferred position, held proceeds, a reservation, nothing left to roll) is
now counted as left to its owner, not reported as a failed fee estimate. The
pass's summary line states how many loans were left that way.
