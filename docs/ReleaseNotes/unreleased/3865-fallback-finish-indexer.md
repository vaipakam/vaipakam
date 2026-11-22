## Indexer — a loan finished in kind after its fallback date

When a loan left in the fallback state is finished in kind after its date, the indexer now closes it: the loan shows as defaulted, and anything still listed against it (a collateral sale listing, a pending swap action) is cleared, as for every other default. The finish's three parts (the lender's, the treasury's and the borrower's) are kept in the activity record with the event, which is what the Activity feed shows.

Both position holders get an inbox row saying a loan defaulted and they should see what they can claim, because after the finish each side collects its part with its ordinary claim. The person who ran the step is not a party and gets no row.

Advances #3865.
