### Instant market: takeover at face value (#3656, part 7b)

A lender can now leave an instant-market loan by handing it to another lender's Auto-lend intent that offers takeovers. The incoming intent pays exactly the principal outstanding into the outgoing lender's vault, and the loan moves to the new lender on the same record. The borrower signs nothing and none of the loan's terms change. The outgoing lender's earned interest stays theirs as a seller claim, paid first from the borrower's next interest payment. No fee is charged, because no loan is opened.

The takeover opens only where a direct sale would: the loan is active and before its due date, outside the claim cooldown, and no other sale route is open. Nothing may be held for the lender position. The incoming intent must accept the loan as if it were new: the rate, the repayment terms, the remaining term, today's loan-to-value and health factor, and room in its exposure. The incoming lender passes the same screens as any new lender, and cannot be the borrower.

It is its own facet beside the instant borrow, because moving a position reaches code that the borrow's transaction size cannot carry alongside. Renewal in place waits for the per-loan reserve (#3681); until then an instant-market loan ends at its due date. This reaches a chain only through a fresh deploy.
