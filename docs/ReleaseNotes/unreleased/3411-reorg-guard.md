## Indexer — catching a reorganisation below the settled block (PR #3528)

The indexer already reads each chain only up to the block the chain itself reports as "safe", so it uses no fixed confirmation counts. What it lacked was any way to notice a chain replacing a block below that point afterwards. Its cursor only moves forward, so rows written from a replaced block would have stayed wrong for good.

The indexer now records, with every cursor advance, the hash of the last block of the range it scanned, in the same database write as the cursor. That hash is read before the range's events, so a replacement that lands while the pass is reading is caught by the next pass instead of being remembered as correct. Every later pass reads that block again by number. If the chain reports a different hash there, it has replaced a block the indexer already wrote rows from. The pass then asks for the chain's rows to be rebuilt, and the next pass carries it out: every row the replay derives is cleared, and the scan replays from the deploy block against the chain as it now is. One remembered block per chain is enough, because replacing any earlier block changes the hash of every block after it.

A rebuild is narrower than the reset a new Diamond gets, because the Diamond is the same. It keeps every row born off chain, the same rows a restore from backup keeps: users' signed orders stay listed, with their filled or cancelled state worked out again by the replay, and alert settings, alert dedupe records, Telegram links and support tickets are kept. A check in the build holds the list of kept tables equal to the table classification, so a new user-owned table cannot be wiped by a rebuild unnoticed.

A rebuild is the rollback because loan and offer rows are updated in place by later events, so a replaced block cannot be undone row by row. It is reserved for an event the chain said would not happen. To keep one bad provider answer from wiping a chain, a different hash must be seen on two reads in a row. A failed read, or two reads that disagree, holds the scan for that pass, in the same way a missing safe block does.

A chain already indexed before this change anchors its cursor where it stands on the first pass. The steady-state cost is one extra block read per pass and no extra database query, because the anchor is read in the same query as the cursor.

Advances #3411. A second part, showing recent events as pending until they are final, follows separately.

> Caveat: during a rebuild, that chain's offers, loans and activity are incomplete until the replay catches up.
> Caveat: the chain's in-app notification inbox is derived from chain events, so a rebuild recreates it and its entries come back unread.
> Caveat: the remembered block can sit just above the cursor when a pass stops short of its range, so a replacement of blocks not yet indexed can also start a rebuild. That is the expensive direction, chosen over missing one.
