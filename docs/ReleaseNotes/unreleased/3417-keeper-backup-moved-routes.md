## Thread — Keeper backup clears offers whose position moved

The keeper backup runner on Chainlink Automation now also cancels a preclose offset, a lender-sale listing or a refinance request whose position has moved since it was posted, or, for a refinance request, that a later request replaced. It does this when our own keeper has left such an offer in place longer than the runner's lag. Such an offer can never complete. Until somebody cancels it, it stays in the book and holds its creator's locked assets, and the cancel refunds them to the creator.

The runner cancels an offer only while the protocol itself reports that the offer's route is dead. Our keeper reads the same thing, so the two follow one rule. The runner never cancels an offer that has merely expired. Anyone may clear one of those, and no keeper is owed that.

Collateral listings and swap-to-repay intents whose position moved needed no change. The protocol has allowed their teardown at once since the moved-position sweep, and the runner's existing listing and intent steps ask the protocol whether each teardown would succeed. So they already cover the moved case.

The new step ships switched off, like every other step. On a Diamond that does not yet have the dead-route read, the step finds nothing. The read reaches the testnets at the next fresh deploy.

Closes #3417
