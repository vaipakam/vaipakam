## Buying a lender position now commits you to how that position actually behaves

When you buy someone's lender position from a listing, you sign the terms you
are agreeing to, and the platform refuses the purchase if what you signed does
not match what you are getting. That check already covered the numbers — the
outstanding amount, a floor under the collateral, the term — and it read those
from the live position rather than from the listing, so a position that moved
between you reviewing it and you buying it cannot be sold to you at the old
figures.

Four things it did not read from the live position: whether the borrower may
repay early in parts, whether they may list their prepayment, whether interest
settles periodically, and which interest model the loan runs under.

Those were read from the listing instead — and the listing does not carry them.
It is assembled by the platform when the seller lists, and it fills in only one
of the four; the other three take the empty defaults of the record it is built
from. So a buyer signed a statement that the position permits none of these
things, the check compared that against the listing, found agreement, and let
the purchase through. The position they received could permit all of them.

Nothing was mispriced and no money moved wrongly. What was wrong is what the
buyer had agreed to: the confirmation they signed described a position that did
not exist, and it was precisely the fields that govern what the borrower can do
to them afterwards. A buyer who cared that the borrower cannot repay in pieces
had that recorded as agreed, and could still be handed a position where they
can.

All four now bind against the live position, alongside the amount and the term.
A buyer signing the old values is refused rather than silently accepted, and the
connected app now reads those four from the position when it prepares your
confirmation, so an ordinary purchase is unaffected.

One related field deliberately stays with the listing: whether the *offer*
permits a parallel sale. That one describes the offer itself and is never
recorded onto a position, so there is nothing live to compare it against.

Worth recording how this was missed for as long as it was. Every existing test
of this purchase path used positions that did not permit early partial
repayment — which is exactly the value the listing defaults to — so the listing
and the position always agreed and the disagreement was never constructed. The
tests passed identically before and after the fix until a case was written where
the two genuinely differ.
