## Thread — Rate Desk says when signed offers are missing (PR #<n>)

The Rate Desk merges free signed offers, which live with the offer-book
service rather than on the blockchain, into the same list as on-chain offers.
When that service did not answer, the list quietly fell back to on-chain
offers only and looked complete. When the service had more signed offers than
it returns, the list ignored that too. In both cases the best rates and the
middle rate could leave signed offers out with nothing on the page saying so.

The offers list now carries a short note in each case. While signed offers are
loading or could not be loaded, it says the list shows only offers posted on
the blockchain and that its best rates may be missing some signed ones. The
chart's description of the middle rate says the same, because on a phone the
chart can be shown without the list. When the service cut its answer short,
the note says so and explains what that means: the service always keeps the
best-priced signed offers on each side, so the best rates and the middle rate
are complete, and only deeper rates and running totals leave some out. A
signed book whose latest refresh failed is now treated as missing instead of
merging the last copy the page saw, since those orders may have been taken or
cancelled in the meantime.

Closes #2386.
