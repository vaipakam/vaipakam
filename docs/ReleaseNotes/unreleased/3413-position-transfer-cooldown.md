## Thread — Position NFTs cool down after value leaves them (PR #<n>)

A position NFT can be sold on any marketplace, and its price depends on what the position holds when the buyer agrees to it. A seller could claim, withdraw collateral or change an offer's terms just before the buyer's order fills, and the buyer would receive a position worth less than they paid for.

Now every action that takes value out of a position stamps it: a payout to its holder (a claim, a held borrower extra, a lender's share of a repayment or a partial liquidation, a swap-to-repay surplus, an in-place extension's interest), a collateral withdrawal, and a change to its terms, offers included. Neither side's token may then move in that block, nor for a cooldown after it. The default is 5 seconds; the admin may set it from 1 second to 10 minutes. The position NFT's transfer check enforces it, so a sale that would land against an emptied position fails on every marketplace. Moves of positions that nothing touched are unaffected.

The cooldown and each token's earliest move time are public reads, so an app can say when a position may move again. The transfer count that protocol routes check is unchanged.

What does not stamp: a former seller collecting their share of a sold lender position, which the current holder does not control, and a sanctions-held park, which pays nobody.

App follow-up: the owner's plan also disables claim actions on positions the app has listed for sale, with the reason. That part ships separately in the app.

Closes #3413.
