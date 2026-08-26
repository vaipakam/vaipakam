# The lender's paid reduction now survives a loan that ends badly

A lender who paid for a fee reduction was getting it on every route a loan could
end *well* — repaid, closed early, refinanced, swapped — and losing it on every
route a loan could end *badly*. If the borrower defaulted, or the position was
liquidated, the full fee was taken from the interest recovered on their behalf.
Same lender, same purchase, different outcome depending on how the loan happened
to finish.

That is now fixed on all five of those routes: an ordinary default, a liquidation,
a discounted liquidation, a split liquidation, and a partial liquidation. Each of
them now applies the reduction to the fee taken from recovered interest, and
every wei the treasury gives up reaches the lender.

## A larger problem on one of those routes

Partial liquidation is the one route that recovers money without ending the loan,
and it was paying the recovered money to whoever the records still named as the
lender — not to whoever holds the position today.

On the routes that end a loan this is caught downstream: they record a claim, and
collecting against that claim checks who holds the position. Partial liquidation
deliberately records no claim, because the loan is still running. So there was
nothing behind it to correct the address, and if the position had changed hands
the previous lender simply kept the principal and the interest, with no way for
the new holder to ask for it.

This was never about the reduction. It was money going to the wrong person, and
it is fixed independently of any decision about the reduction itself.

## And one route was reducing the right fee for the wrong person

Refinancing did apply the reduction, but resolved it against the stored lender.
It attempts to refresh that record first, but that refresh is allowed to decline
quietly — it is designed never to block a close-out — so on a position that had
changed hands the previous lender's holdings could set the size of a reduction
the buyer received, and once the token peg is configured, could be charged for it.
It now resolves against the current holder, like every other route.

## Why the same helper now lives in one place

The step that applies the reduction had been copied by hand into five separate
components and one shared module. This change would have made it nine. It is now
written once. That is not a size saving — the compiler inlines it either way —
but the early exit inside it is the part that decides whether a settlement
consults the reduction machinery at all, and six hand-maintained copies of that
decision is how they quietly stop agreeing.

## What this does not change

Nothing here is visible until the fee-entitlement switch is turned on, because no
loan carries the paid stamp before then. Turning that switch on remains gated, and
the checks for it stay manual — see the operator runbook.
