## Indexer — catching a reorganisation below the settled block (PR #<n>)

The indexer already reads each chain only up to the block the chain itself reports as "safe", so it uses no fixed confirmation counts. What it lacked was any way to notice a chain replacing a block below that point afterwards. Its cursor only moves forward, so rows written from a replaced block would have stayed wrong for good.

The indexer now records, with every cursor advance, the hash of the block it advanced to, in the same database write as the cursor. Every later pass reads that block again by number. If the chain reports a different hash there, it has replaced a block the indexer already wrote rows from. The pass then asks for the chain's rows to be rebuilt, and the next pass carries this out through the same reset a new Diamond deployment uses: every chain-scoped row except the user's own is cleared, and the scan replays from the deploy block against the chain as it now is. One remembered block per chain is enough, because replacing any earlier block changes the hash of every block after it.

A rebuild is the rollback because loan and offer rows are updated in place by later events, so a replaced block cannot be undone row by row. It is reserved for an event the chain said would not happen. To keep one bad provider answer from wiping a chain, a different hash must be seen on two reads in a row. A failed read, or two reads that disagree, holds the scan for that pass, in the same way a missing safe block does.

A chain already indexed before this change anchors its cursor where it stands on the first pass. The steady-state cost is one extra block read per pass and no extra database query, because the anchor is read in the same query as the cursor.

Advances #3411. A second part, showing recent events as pending until they are final, follows separately.

> Caveat: during a rebuild, that chain's offers, loans and activity are incomplete until the replay catches up.
> Caveat: the rebuild clears the same rows a new deployment does. The chain's in-app notification inbox is rebuilt, so its entries come back unread. Alert dedupe records that are chain rows are cleared too, so an alert whose condition still holds may be sent once more.
