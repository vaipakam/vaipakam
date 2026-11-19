## Indexer and app — the protocol console hears the price guard, and shows its waiting changes

Since the pricing settings moved to the standalone price guard, the indexer read only the Diamond's logs, so a feed swap, a new guardian or a repointed guard reached the protocol console's snapshot only on its six-hour backstop. A change waiting out the guard's delay never showed at all, although that delay exists so people can see a change coming.

The indexer now reads the price guard's and the protocol registry's logs in the same request as the Diamond's, and splits them off by address before the Diamond decode, since some of their events share a signature with the Diamond's own. Any registry event, or any guard event that changes a setting or the list of waiting changes, refreshes the snapshot as a Diamond governance event does. The guard read is the one the last snapshot named, so a repointed guard is followed from the pass after the snapshot that read the new pointer. The six-hour backstop stays as the fallback.

Each change the guard announces as proposed (including a secondary source's removal) is recorded until the event that carries it out or cancels it, in the same transaction as the scan cursor, and every snapshot refresh checks each recorded change against the guard at the snapshot's block. The public config route serves the list with the first block whose guard logs were read, because a change proposed before then cannot be known from the logs. Steady passes cost no extra request or query.

The protocol console gains a section listing the waiting changes, each with its new value written the way its setting is written and when it can be carried out, and a note on the matching setting's row. It says whether the list reaches back to the deployment or only to a block, and when the page shows a direct chain read or the index gave no list, it says the list is unknown rather than empty. The guard's settings and the guard pointer no longer carry the "announces nothing on chain" note.

> Caveat: on a chain already running, the list starts at the first pass of this release; a change proposed earlier and still waiting is not listed, and the console says so. A fresh deploy is read from its deploy block.

Closes #3453.
