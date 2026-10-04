## Thread — Offer Book cards state the loan-to-value (PR #<n>)

The October live review asked the Offer Book to show the three facts a lender
decides on: the collateral amount, whether the collateral is liquid, and the
resulting loan-to-value. The first two shipped earlier; this adds the third.

Each token-for-token offer card now states its loan-to-value, worked out from
the protocol's live oracle prices with each side valued by its own token's
precision, the same way the protocol values a position. A borrow request's
collateral is the least it commits, so its figure reads "at most". Where a
figure cannot be backed the card says why instead of showing one: one side has
no reliable price, a price could not be read right now, or the prices are still
loading. Rentals, offers with an NFT on either side, offers with no collateral
and loan-position sales state no ratio. The prices for the visible page are
read in one batch and refreshed every minute.

While building it, the contract's public pair-level loan-to-value view turned
out to ignore token decimals, which makes it wrong for pairs whose tokens use
different precision. The card does not use it; the contract issue is tracked
separately as #2403. Closes #2384.
