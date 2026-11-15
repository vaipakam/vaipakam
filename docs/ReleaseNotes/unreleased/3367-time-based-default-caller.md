## Thread — Time-based default sales name their caller in the liquidator count (PR #<n>)

The liquidator count on the loan stats (#3366) treated the time-based default as a route whose caller is not recorded, and counted it from an event called `LoanLiquidated`. That event was declared on the default facet but never emitted, so every time-based default sale was missing from the figure, not just its caller.

The caller was already on-chain. Every forced sale emits one settlement record naming the caller who triggered it, and the record says which kind of sale it was. The count now reads the rows whose kind is the time-based default, and files them under that caller beside the internal match and the periodic auto-liquidation. Those rows are shown but not counted toward the bonus-auction threshold (#3355), which covers only the Health-Factor routes. The other kinds of that record repeat a sale that another route's own event already names, so they are left out rather than counted twice.

A time-based default that sells nothing pays its caller nothing, so it is not a liquidator's sale and is not counted. That covers an in-kind transfer of illiquid collateral, and the fallback entered when the collateral is unpriced or every swap failed. The response states this in its caveats.

The dead `LoanLiquidated` declaration is removed from the default facet, together with the indexer branch that handled it, its notification note, and the app's activity label for it in English and the nine translated catalogues. The position NFT's "Loan Liquidated" status is a different thing and is unchanged. The ABI loses one event and gains nothing, so no call changes.

Closes #3367

> Caveat: the indexer's `liquidated` loan status was set only by the removed handler, so nothing produces it now. Removing the status from the indexer and the app is a separate cleanup (#3630).
