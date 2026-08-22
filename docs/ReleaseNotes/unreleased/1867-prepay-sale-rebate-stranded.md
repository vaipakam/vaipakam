## A fee rebate could be settled onto a closed loan and then be unreachable (#1867)

Loans opened under the retired VPFI fee arrangement hold a small amount of the
borrower's VPFI, and give part of it back when the loan closes properly. That
give-back normally waits on the closed position for the holder to collect.

One closing route does not work that way. When collateral is sold through the
marketplace, everything owed is distributed in the same transaction and the loan
is marked as having nothing left to collect — which is what makes that route
safe to mark closed immediately. The rebate was being calculated and set aside
for collection anyway, onto a loan the collection path refuses to serve by
design. Nobody could retrieve it: not the borrower, not the buyer, not an
operator.

It is now delivered in that same transaction, into the vault of the party the
refund was calculated for — the original borrower, who paid the fee. Sale
proceeds still follow whoever holds the position; a refund follows whoever paid.
Keeping those two apart is what makes the amount and the recipient agree, and it
holds even when the borrower is someone the platform is required to screen: the
money is their own, so it reaches their own vault, and the sale is never refused
over it. That keeps the promise the route is
built on — everything settled at once, nothing left to collect — rather than
carving an exception into the collection path to accommodate a state that should
not exist.

Only loans opened under the retired arrangement can be affected, so a platform
started fresh never had money at risk here. What was worth fixing regardless is
the contradiction: one closing route was declaring "nothing left" while creating
something, and that is the kind of inconsistency that invites the wrong repair
later.
