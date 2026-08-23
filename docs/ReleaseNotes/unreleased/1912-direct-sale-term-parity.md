## Selling a position directly can no longer hand a buyer terms they never agreed to (#1912)

A lender leaving a loan early has two ways out. They can put the position up for
sale and wait for a buyer, or they can sell it straight into an offer somebody
has already left standing. Both move the same position to the same kind of
counterparty, and the platform requires them to behave identically — a rule that
applied to one and not the other would let the same position be sold on
different terms depending on which door it left by.

They were not behaving identically.

A loan carries terms that decide what the borrower may do to whoever holds the
lender side: whether the loan may be repaid in parts, whether interest is owed
for the whole agreed term or only for the time the money was actually out,
whether interest settles periodically, and whether the borrower may put the
collateral up for sale. It also carries the identity of the specific asset
backing it.

On the listed route none of this can go wrong, because the offer put up for sale
is built from the live loan. What the buyer reads and agrees to is the
position's real behaviour, and nothing else can be delivered to them.

The direct route works the other way around. It spends an offer its author wrote
earlier, for a loan that did not exist yet — so there is nothing to build from,
and the two descriptions have to be reconciled instead. They were not being
reconciled at all. Every one of those terms was simply discarded, and the buyer
inherited whatever the loan happened to carry. Someone who wrote "no repayment
in parts" could be moved into a loan that allows it; someone who chose full-term
interest could end up on a pro-rata loan.

The most consequential of them reached past the buyer entirely. Permission for
the borrower to put the collateral up for sale is fixed when the loan is
created, and that is the copy the platform checks later. A buyer who had
declined that permission could inherit a loan where it was granted — after which
the borrower could list the collateral against a lender who had never agreed to
it.

The direct route now refuses a sale whose standing offer disagrees with the
position it would buy, and says which term disagrees rather than failing
generically — a seller can act on "the buyer's offer expects no partial
repayment", and cannot act on "invalid offer".

The check is exact rather than lenient in the buyer's favour. Being handed
*stricter* terms than you wrote still leaves you holding a position you did not
agree to, and the listed route could never deliver that, so accepting it here
would recreate the very door-dependent difference the two routes are forbidden
to have. Terms the listed route leaves alone are deliberately left alone here
too, for the same reason read backwards.

Nothing changes for a sale where the offer and the position already agree, which
is the ordinary case: an offer written with the usual defaults against a loan
carrying those same defaults fills exactly as before.

This is the same defect that was found and fixed on the listed route earlier,
arriving late on its sibling. That it could sit open on one route after being
closed on the other is the more useful lesson: the two routes are checked by
separate hand-written lists, and nothing forces a term added to one to appear in
the other. The code now says so plainly where the list lives, rather than
implying a safety net that does not exist.

Closes #1912.
