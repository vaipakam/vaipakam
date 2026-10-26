## Thread — Rent is counted in whole days, with a one-day minimum (PR #TBD)

A rental that is closed early now pays for every day it has started, not
only for the days that have fully passed. Before this change the rent
owed on a pay-for-time-used rental, and the catch-up rent settled when a
rental obligation is handed to a new borrower, counted only completed
days. A renter who returned an NFT inside its first day paid no rent at
all, and one who returned it a few hours into a later day paid nothing
for those hours.

The rule is now the same on every rental close. Time since the rental
began rounds up to whole days, at least one day is always charged, the
count never goes past the agreed term, and days already paid through the
daily deduction are never charged again. A rental closed exactly on a day
boundary is not charged an extra unused day. The rent comes out of the
prepayment the renter already funded, so the lender receives it and the
renter's refund shrinks by the same amount; nothing else moves.

The rule is stated in the functional specification, and the offer form
now shows it under the pay-for-time-used option whenever the offer is a
rental, in every supported language.

Closes #2741.
