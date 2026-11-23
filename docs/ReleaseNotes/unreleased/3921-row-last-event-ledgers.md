## Troubleshooting — every derived row now names the event that last changed it

The reward and recycling ledgers now record the chain event that last changed
each row: the block, the transaction's position in it and the log's position.
That covers the recycling day series, the pre-launch and per-chain recycling
totals, the reward loop's day, user and running totals, each user's retained
rewards, and the record of reconciled commitment days. Each of these rows adds
up many events, so it names the latest one added in.

This was the last handler group. Every table the indexer derives from chain
events now carries the three columns, and a check refuses any write to such a
table that does not set them, or does not say why it changes no figure an event
produced. The interim list of tables still to convert is gone. A wrong figure
anywhere in the indexer's derived data can now be followed back to the
transaction that produced it, and the transaction explainer then shows what
that transaction did.

Rows rebuilt from the stored activity feed name the event's block and log
position, with no transaction position, because the feed does not keep one.

Advances #3921. Part B2 is complete; the issue stays open for its remaining
parts.
