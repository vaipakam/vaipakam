# Restored signed orders stay off the book until the replay re-reads them

Closes #3544

A restore from the nightly archive imports each signed order as live and
unfilled, and the block-zero replay that follows then re-applies every fill,
match and cancellation from the chain. Until that replay caught up, an order
that had in fact been filled or cancelled could be listed on the public book
as live, if the indexer served while the replay ran.

The restore converter now marks each imported order with the height its chain
had been indexed to when the archive was written, read from the archived scan
cursor. This is the same mark a reorg rebuild already uses: the order is left
out of the signed-offer book and the market summary, the book reports how many
orders are waiting, and the indexer lists each order again by itself once its
scan reaches that height. Rebuild and restore now hide and release orders the
same way.

If an archive has no cursor for a chain that has orders, the converter stops
and names the chain rather than list those orders early. The operator then
gives that chain's height with a new `--replay-through` option, which can also
raise a chain's height but never lower it. The restore runbook explains both.
