## Thread — early under-collateral warning on the borrow terms step (#1112)

A borrower whose collateral is too low for the amount they want to borrow was
only told so at the **review** step — after clicking all the way through
details → terms → review — where the pre-sign simulation surfaces the
contract's `MaxLendingAboveCeiling` / `MinCollateralBelowFloor` /
`InitLtvAboveTier` revert as plain-language copy. For a naive-user flow that's a
step too late: the amount and collateral are entered on the *terms* step, so the
warning belongs there.

The terms step now runs the same read-only `createOffer` `eth_call` the review
step does — with the risk-and-terms consent **forced true in the preview
payload only** (never signed), so the consent gate (which is ticked at review)
doesn't mask the collateral check while the user is still editing amounts — and
shows an inline warning the moment the borrow is under-collateralised. It warns
**only** on under-collateral reverts; every other pre-sign failure (self-trade,
duration cap, a still-incomplete form, an allowance the submit path grants
first) stays silent here and is still caught by the review-step simulation, so
the terms step never cries wolf. The check is advisory — it never blocks the
"Continue to review" button — and the message is decoded from the contract's
own revert, never a client-side re-implementation of the risk math.

Scoped to the borrower's own post flow. The decision logic (which reverts count
as "under-collateral", and the no-crying-wolf exclusions) is unit-tested; the
observable inline warning is verified live per the definition-of-done, matching
how the existing friendly-contract-error UX is covered (a genuine
under-collateral revert isn't reproduced by the Anvil fork). Closes #1112.
