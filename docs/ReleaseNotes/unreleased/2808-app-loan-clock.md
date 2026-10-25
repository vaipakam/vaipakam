## Thread — The app states loan due dates on the loan clock (PR #2830)

Since the D2 pause change (#668 / #935), a pause moves every open loan's due
date and grace end later by the time the protocol spent paused since the loan
started. The contracts and, since the previous change, the indexer and the
reminders work from the moved dates. The app still showed and checked the
original ones, so after a pause it would have shown a borrower a due date
earlier than the one the chain holds them to, warned of a late fee that is not
charged, and refused some sales, offsets and handovers as too long for a loan
that in fact had the time.

The app now reads the protocol's pause record with every live loan read and
works from the moved dates everywhere a deadline matters: the loan page, the
positions list, the late-fee and grace checks before a repayment, cure,
preclose or refinance, the term a sale, offset or obligation handover must fit
inside, and the remaining interest a sale or transfer is priced over. Where a
pause moved a loan's due date, the loan page says so in its own row: the
original date, how far the pause moved it, and why. While a pause is in force
the page and the list say the date is still moving rather than naming one, and
a loan the app cannot date says the due date is unknown rather than showing
the original date as current. When the list reads a wallet's loans from the
chain, it dates them from one read of the pause record and the grace schedule
at a single block. A rental's paid-use end date is not moved, because a pause
does not extend paid use; only its late-fee and default deadlines move.

The new wording is translated into the nine translated languages. Contracts
deployed before the loan clock have never moved a date, so on those chains
(the current testnets until their next refresh) nothing visible changes.
Refs #2808.
