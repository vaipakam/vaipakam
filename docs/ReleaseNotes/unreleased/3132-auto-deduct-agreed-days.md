## Contracts — the daily rental deduction charges only an agreed day (PR #3160)

The daily rental deduction is permissionless: anyone may call it once a day
has passed since the last deduction, and it moves one day's fee from the
renter's prepayment to the lender and the treasury. It did not check that the
day was one the rental's terms provide. A renter who prepaid the whole term
with a rental partial, and then closed after maturity, could be charged extra
rental days by any caller in the meantime, although the platform's rule is
that time past maturity is the late fee, drawn from the buffer at close, and
never an extra rental day.

It now refuses once every agreed day is paid, with an error naming the loan.
It also refuses a rental whose deduction clock reads earlier than the
rental's start. On such a record the days-used count stays at zero however
many days are charged, so each call would charge again; the refusal names
the clock and the start it was compared with. Neither case arises from a
loan opened by the current code, which sets the clock to the start, but the
deduction no longer relies on that.

Both checks read the platform's one rule for counting rental days used, the
same rule repayment and the obligation handover settle by. The last agreed
day is still charged and still closes the rental.

The keeper already declined both cases before sending (#3097) and keeps
those checks as a free pre-filter. This reaches a chain at the next fresh
deploy or facet refresh of RepayPeriodicFacet.

Before this change, a rental prepaid for its whole term by a rental partial
was closed by the first deduction after maturity, at the cost of that extra
day. That accidental close is gone: such a rental now closes when its
borrower repays, or defaults after grace like any other open loan. The owner
decided to keep it that way rather than add a permissionless close at
maturity (#3159).

Closes #3132.
