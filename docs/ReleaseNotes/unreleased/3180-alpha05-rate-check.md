# The next app warns when an offer's rate is far from recent loans

Both posting forms in the next app, a lender's offer and a borrower's request, now show how the typed rate compares with recent loans. Under the rate field, the form reads from the index the loans that started on the same pair and term in the last 30 days and shows their middle rate and how many there were.

A rate more than five points away from that middle rate is a warning that says which way it cuts. A lender far under the market, or a borrower far over it, posts the offer that is taken first when rates move. The other way, the offer may sit untaken. Within five points the form shows a plain note.

Only agreed rates the index can back are counted, and loans opened by a lender's sale of a running loan are left out, since a sale is not a fresh rate. Loans on the pair whose terms the index has not yet confirmed cannot be placed in a term, so the form states how many there are beside the comparison. When there are no recent loans to compare with, when the collateral is an NFT, or when the index cannot be read, the form says so, so a missing comparison never looks like a clean one. The warning never blocks posting.

New offers still default to a 7-day expiry. Choosing to keep an offer open until it is taken or cancelled now shows a note that such an offer keeps its rate as the market moves.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-RATE-CHECK. Part of #3357; epic #3180.
