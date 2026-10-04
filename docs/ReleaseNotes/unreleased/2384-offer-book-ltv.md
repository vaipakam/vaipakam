## Thread — Offer Book cards state the loan-to-value (PR #<n>)

The October live review asked the Offer Book to show the three facts a lender
decides on: the collateral amount, whether the collateral is liquid, and the
resulting loan-to-value. The first two shipped earlier; this adds the third.

Each token-for-token offer card now states its loan-to-value — the loan's
value as a share of the collateral's, said in those words on the card — worked
out from the protocol's live oracle prices with each side valued by its own
token's precision, the same way the protocol values a position. The figure is
the ratio at the amounts the card shows; where a fill of another size could
carry a different ratio (a ranged or part-taken lend offer, and any borrow
request, whose collateral is only a floor) the card says so rather than
calling it exact or a limit. Where a figure cannot be backed the card says
why: one side is treated as illiquid (no reliable price or too little
trading), one side's value rounds to nothing at that size, a price could not
be read right now, or the prices are still loading. Rentals, offers with an
NFT on either side, offers with no collateral and loan-position sales state no
ratio. The prices for the visible page are read in one batch and refreshed
every minute.

While building it, the contract's public pair-level loan-to-value view turned
out to ignore token decimals, which makes it wrong for pairs whose tokens use
different precision. The card does not use it; the contract issue is tracked
separately as #2403. Closes #2384.
