## Thread — The NFT verifier shows a retired token's history

The verifier already tells a retired position token from one that was never minted, from the chain. For a retired token it now also shows what the public index recorded about it: the loan or offer the token belonged to, which side, the final status, the agreed amount, interest rate and duration, the last recorded collateral, and when the token was retired, with a link to that transaction. The verdict itself is unchanged and still comes from the chain; the history appears under it only when the index has a record, and the page says nothing extra otherwise.

The index could not answer this before. A loan record carries only its current token ids, and a sale, a takeover or an obligation handover replaces a side's token with a new one, so the old token matched nothing. The indexer now keeps a ledger of every token id a loan or offer has held, filled by database triggers on the loan and offer records so that every write path that sets a token id records it without a separate step. A new read route, `GET /positions/:tokenId`, answers from that ledger and from the retirement event the indexer already stores.

What the panel cannot confirm it says so. The agreed amount, rate and duration appear only where the index has matched them to the chain's initiation event; otherwise each reads "Not confirmed by the index", never the loan's later terms in their place. The collateral is labelled as the last recorded amount. The reason for the retirement is named only where the record shows it: the side passed to a new holder with a new token, the loan closed, or the offer was cancelled. Any other retirement keeps the general "retired by the protocol" wording.

The ledger is backfilled from the ids the records hold today. A token a record held and replaced before this change cannot be recovered from the records, so the route reports no record for it. On the next fresh deploy the ledger starts with the chain and is complete.

Closes #3021.

> Caveat: shared migration 0115 adds the ledger table, its triggers and one index; the restore runbook now clears the table with the other replay-derived ones.
> Caveat: no Anvil spec renders the panel yet (the fixture retires no token before the verifier spec); a live drive is owed after the next fresh deploy.
