### A lender may take partial repayment and the prepay listing either way (#3621)

A match pairs two offers only when they chose the same lifecycle terms. Until now that meant a lender who did not mind whether a loan allowed partial repayment, or a prepay listing of the collateral, still missed every request that chose differently, and the book split into small pools that never met.

A lender offer can now say "either" for partial repayment, for the prepay listing, or for both. Such an offer matches a request whichever way the request chose, and the loan takes the request's choice, exactly as it already takes every lifecycle term from the borrower's offer. For an option the lender did not mark, the two offers must still agree. The interest mode, the periodic-interest cadence and the rental-fee asset always have to agree.

Only the lender gets this choice, and only on an offer it posts or signs itself. A borrower offer, an NFT rental and the offers the protocol creates on a user's behalf (a loan sale, the offset offer, a standing-intent slice) are refused if they carry it, and so is any setting the protocol does not define. The choice is fixed when the offer is posted. A signed offer carries it in the signed data, so the maker's signature covers it. Accepting such an offer directly takes its stated values unchanged.

The offer-created details state the choice, the signed-offer book refuses it on a borrower order, and the new app's "why isn't my offer matching?" no longer names an option the lender takes either way. Neither app lets a lender set it yet; that form work, with the disclosure the lender signs, follows.

This changes the offer layout and the signed-offer type, so it reaches a chain only through a fresh deploy. Design: `docs/DesignsAndPlans/IdleLiquidityMatchingDesign.md` §2.

Closes #3621
