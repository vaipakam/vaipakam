## A seller's listing can now be held to the quote they reviewed (PR #TBD)

When a lender lists their position for sale, the platform records two figures
that protect them for the life of the listing: the least they can receive if
it fills (the floor), and the most already-set-aside money that can transfer
with the position (the held ceiling). Those figures are computed when the
listing lands on chain — which is moments *after* the seller decided, looking
at a quote. If the loan moves in between (a borrower partial repayment is
enough), the listing records worse figures than the seller reviewed, and the
protections then faithfully protect the worse numbers.

There is now a second way to submit a listing that closes that seam: the
seller's interface passes along the floor and ceiling it showed them, and the
listing is refused if what it would actually record is worse — a lower floor,
or a higher held ceiling. Better-than-reviewed always passes; only adverse
drift is refused, and the refusal names both figures so the interface can
re-quote and explain what moved. The original submission path is unchanged
and remains available, so nothing already built against it is affected.

This is the platform half of the seller-quote work: the interface half — the
listing form showing the guaranteed floor for the chosen duration, and the
live-listing card explaining an unfillable listing — follows once this is
deployed where the interface can reach it.

Part of #1503 (item 4 follow-through); tracked as #1810.
