## A lender-position listing now describes the position it is selling

When you buy someone's lender position from a listing, you sign the terms you
are agreeing to, and the platform refuses the purchase if what you signed does
not match what is on offer.

The listing you sign against is not written by the seller. The platform
assembles it from the live position at the moment the seller lists. It filled in
the numbers — the outstanding amount, the term, the collateral — and one of the
behavioural terms, and then simply left the rest blank. Three fields never got
copied across: whether the borrower may repay early in parts, whether they may
list their prepayment, and whether interest settles on a periodic schedule. A
blank in those fields does not read as "unknown"; it reads as "no".

So a buyer was shown, and signed, a statement that the position permitted none
of the three. The check compared that against the listing, found agreement, and
let the purchase through — because the listing genuinely did say so. The
position they received could permit all three.

Nothing was mispriced and no money moved wrongly. What was wrong is what the
buyer had agreed to: the confirmation they signed described a position that did
not exist, and it was precisely the fields that govern what the borrower can do
to them afterwards. A buyer who cared that the borrower cannot repay in pieces
had that recorded as agreed, and could still be handed a position where they
can.

The listing now carries all three, copied from the position when the seller
lists. That is enough, and it is permanent: these three terms are fixed when the
loan is first taken and never change for as long as it runs, so a value copied
at listing time cannot go stale. Every screen that shows you a listing's terms,
and every app that prepares your confirmation, reads the listing — so all of
them became correct at once, with no change needed on their side and no window
where one half of the platform disagreed with the other.

Two consequences worth stating, because each is a thing you could otherwise
run into:

**Listings made before this change are not yet covered.** Such a listing still
carries the blanks while its position carries the truth, and no amount of
re-signing fixes that — the buyer is signing the listing faithfully; it is the
listing that is wrong. The right answer is to refuse the purchase so the seller
relists, and that refusal is written and tested but is **not part of this
release**: the contract it belongs in is within a hundred-odd bytes of the
hard size limit Ethereum places on a single contract, and adding it would leave
no room for any later correction to that same contract. It is tracked
in #1835 and lands once that contract has been split. Until then, buy from a
listing created after this release; a seller with an older listing can simply
cancel and relist to produce a correct one.

**Listing a position that settles interest periodically keeps working.** Copying
the schedule across meant the listing was, for a moment, being checked against
the rules for setting up a brand-new loan — rules like "the payment interval has
to be shorter than the term". A running position routinely fails those, not
because anything is wrong with it but because it has aged: a loan that pays
annually has less than a year left the day after it starts. Applying them would
have quietly removed the seller's exit from ordinary healthy positions. A sale
hands over an existing position rather than creating a new one, so those
set-up-time rules no longer apply to it — the schedule is recorded as-is.

Worth recording how the original gap went unnoticed for as long as it did. Every
existing test of this purchase path used positions that did not permit early
partial repayment — which is exactly the value the listing left blank — so the
listing and the position always agreed and the disagreement was never
constructed. The tests passed identically before and after the fix until a case
was written where the two genuinely differ.
