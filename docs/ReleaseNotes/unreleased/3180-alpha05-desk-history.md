## Thread — alpha05 rate desk: your live loans in a market and your desk history

Below a market's activity, the new app's rate desk now shows the connected wallet's live loans in that market. They come from the app's own reading of the wallet's positions on the chain, the same one the Positions page uses, not from the index. Each loan says which side the wallet holds, the amount and rate, and its health factor, or that there is no health reading. Each links to the loan's page, where the protocol decides what can be done. If the positions were not read in full, the desk says a loan may be missing.

Below that, the desk lists the wallet's desk history from the protocol's index: every token loan against token collateral it has held a side of, at any status, newest first, twenty at a time. The index keeps an append-only record of who held each side, so a loan the wallet lent, was repaid on and collected from still appears after its position is gone. Each row shows the market, the side held, the status on record and when the wallet last took a side. The status is labelled as the index's record, which can trail the chain, and each row opens the loan's page, which reads the chain.

A "Show older loans" button appears only when the index actually returned a loan beyond the current page, so a list that ends exactly on a page boundary does not offer an empty page. A row the app cannot read is counted rather than silently dropped, and a failed read is stated instead of showing an empty history.

The order ticket and signed orders follow in later slices. Advances #3180.
