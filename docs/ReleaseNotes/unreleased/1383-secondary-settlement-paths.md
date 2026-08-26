# The lender's paid discount reaches every repayment route — and none of the recovery ones

A lender who paid the optional up-front tariff on a loan earns a further
reduction of the fee taken from their interest. When that arrangement was
specified, several of the ways a loan can be settled did not yet apply it, and
the specification recorded all of them as outstanding — and as something that
must be resolved before the tariff can be switched on at all.

Most of them have since been implemented, and the specification had not caught
up. Closing early by handing the obligation to someone else, closing by
offsetting against a new position, repaying part of the amount, paying interest
periodically, and the automatic lifecycle path where the position has changed
hands all now apply the reduction, and all of them key it on the party actually
being paid rather than on whoever the loan first recorded as lender.

One entry on the old list turns out never to have belonged there. A rental loan
cannot carry the paid arrangement at all — the tariff is only ever charged when a
loan is originated in an ordinary token, and a rental pays no origination fee to
be tariffed alongside. There is no rental lender who paid and could be owed
anything, so that route is dropped rather than fixed.

What the review turned up instead is a set nobody had listed: the ways a loan
ends **without being repaid**. When a loan defaults, or is liquidated, whatever
interest is recovered still has the ordinary cut taken from it — and none of
those routes consults the lender's arrangement, so a lender who paid for the
reduction does not receive it. The original enumeration named only the repayment
and early-close routes, so the recovery routes were never in scope and never
decided against either.

The specification now says that plainly: five routes honour it, rentals are
outside it by construction, and the outstanding question — the one the switch
stays blocked on — is whether interest recovered after a default is lender
interest for this purpose. Answering it either way resolves the block. What could
not stand was leaving a lender's entitlement dependent on how their loan happened
to end, without anyone having chosen that.
