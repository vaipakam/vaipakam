## Thread — Range matches fill the largest amount both sides accept (PR #TBD)

A permissionless range match used to lend the midpoint of the two offers' amount overlap. A lender offering up to 100 against a borrower wanting up to 100 got a loan of about 50 plus the minimum, and reaching the full amount took further matches, each its own loan paying its own gas and matcher share. The midpoint is a fair split for the rate, because neither side should take the whole surplus. For the amount it has no fairness reason: both parties said they accept anything in the window.

A match now lends the largest amount both offers accept. That is the smaller of the lender's remaining capacity and the borrower's remaining request, capped at what the borrower's available collateral covers at the lender's pro-rated requirement, and never below either offer's minimum fill. Before, a pair whose collateral covered the midpoint but not the top of the window still matched at the midpoint. Now it matches at the most the collateral covers rather than being refused. The rate is still the midpoint of the rate overlap. All-or-nothing offers and refinance carry-over matches keep their own amount rules. The match preview, the signed-offer matcher and the lender-intent fill run the same rule, since they share one match core.

Owner decision 2026-11-08. Closes #3326.

> Caveat: OfferMatchIntentFacet now has about 150 bytes of headroom under the contract size limit. The next change to it needs a split along a real seam.
