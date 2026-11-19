## Thread — Interest paid stated per loan (PR #<n>)

Every interest payment on a loan now emits one record naming the loan, the asset and the amount. Before this, the protocol counted interest paid only as a per-asset total, and the amount a payment carried could be read only from the record of the route that made it. Several routes name no interest figure at all: a partial repayment, a refinance payoff, and repayment with collateral (full and partial). So a loan's history could not say how much interest it had paid, and the rate-curve work (#3751) could not weight loans by interest paid.

The record is emitted at the one step every interest payment already passes through, the step that grows the lifetime interest counter. Every route is covered at once, and a route added later is covered without anyone having to remember it. The amount is the same figure the counter grows by: the interest the settlement charged, late fee included where the route charges one, before the treasury's share. A forced sale states what it recovered, not what was owed. The record states what the loan paid, not who received it; on a sold loan the seller-claim records already state the split.

A second record is the take-back. When a payment parked for the lender side arrives short and leaves interest still owed, it names the loan and the interest taken back. A later payment that settles that interest states it again. So the interest a loan has paid is the sum of its payment records less its take-back records, which is how the counter itself moves. A recovery in kind (the default and liquidation fallbacks) states no record, for the same reason the counter does not count it: it settles principal, interest and any bonus as one amount.

We chose one record at that step over adding an interest field to each route's own record. The per-route option would change several record shapes the indexer already reads, and the next route could forget it.

The indexer does not read the two records yet. Its event-coverage check lists them as deliberately not handled, with the reason, until the indexer change that stores interest per loan and moves the #3751 band onto it. Each facet that carries the step grew by 63 to 127 bytes; the closest to the size limit, RepayFacet, keeps 452 bytes of headroom.

Closes #3755
