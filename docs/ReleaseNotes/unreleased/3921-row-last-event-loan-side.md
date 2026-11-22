## Troubleshooting — the loan side tables name the event that last changed them

The rows the indexer keeps beside each loan now record the event that last
changed them, as offer and loan rows already do: the block, the transaction's
position in it, and the log's position. That covers the loan's lifecycle record,
NFT rental rights, swap-to-repay intents, prepay sale listings and the list of a
loan's position holders. A wrong rental, a listing with the wrong grace end or a
holder missing from a loan's history can each be followed back to the
transaction that produced it.

The three columns say what they know, by the same rule as the offer and loan
rows. A listing's grace end is read from the chain at its event's block, so a
listing row names that block rather than the event. When that pinned read fails
and the indexer falls back to the chain's head, it now says so. That read's
block cannot be named, so the row records unknown rather than keep naming
whatever it named before. The same now holds for every derived row: a write
whose figures came from an unnamed source makes the row unknown, while a
stored unknown still gives way to any later known position.

A holder the reconciliation repair confirmed on chain records the block it was
read at. Every other holder row names the event that made the wallet a holder.

Advances #3921. The signed offer book and the reward and recycling ledgers
follow, one group each, until every event-derived table carries the columns.
