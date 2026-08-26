# The lender's paid discount now reaches all but one settlement route

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

One route still does not: the settlement of an NFT loan's rental fee out of the
borrower's prepayment. There the fee is split and the lender's share paid across
without the lender's arrangement being consulted at all, so a lender who paid the
tariff gets nothing extra on that route.

The specification now says exactly that — five routes honour it, one does not,
and the switch stays blocked on the one. It also records the alternative to
implementing it: deciding explicitly that a rental fee is not lender interest for
this purpose, and taking it out of scope. Either resolves the block; leaving the
list vague did not.
