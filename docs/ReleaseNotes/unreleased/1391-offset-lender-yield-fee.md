## Thread — Honor the lender Full/hold stamp on the offset close-out (PR #<n>)

Follows #1383. The lender fee discount is now honored on the **offset** close-out
— the route where a borrower replaces their existing loan with a new one and the
original lender is paid off as part of that swap. Until now this was the one
close-out where the treasury took its cut with no discount, so a lender who had
paid for the discount lost it purely by exiting through an offset instead of an
ordinary repayment or early close.

The offset is unusual: what the lender is owed is worked out while the
replacement offer is being posted, but the money only actually moves later, when
someone accepts that offer. The figure the discount has to be sized against is
therefore calculated in one step and spent in another, and it now gets carried
across that gap so the discount is applied to exactly the same amount the
treasury cut was taken from. The extra top-up the lender receives when the
replacement loan pays less than the original stays outside that figure, since
the treasury never takes a share of it.

Delivering the discount inside someone else's acceptance transaction is safe in
both forms it can take. The form that simply reduces the treasury's share moves
no tokens at all. The form where the lender pays the fee in VPFI instead is
already gated on that lender's own recorded opt-in, so an acceptance by another
party can never spend the tokens of a lender who never opted in — they receive
the benefit through the no-token-movement route instead.

As with the other close-out paths, the discount is resolved for **whoever
currently holds the lender position**, which is who a claim actually pays out to,
rather than whichever address the settlement bookkeeping still happens to name.

Ships **dark**: no loan carries a Full lender stamp until the fee-entitlement
cut-over, so every current offset settles exactly as it did before — now also
including the opt-in hold discount this path formerly ignored.

Closes #1391. Umbrella: #1349.
