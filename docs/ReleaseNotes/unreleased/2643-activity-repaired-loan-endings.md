## Thread — The Activity page shows a repaired loan's ending (PR #2701)

When the indexer misses a loan's ending event for good, its reconciliation pass reads the loan's status from the chain and closes the loan's record. Since #2195 the indexer serves what that check observed beside the activity feed, but the app ignored it, so such a loan's history on the Activity page simply stopped, with no ending.

The Activity page now asks for those entries and shows each one for the wallet's own loans as an observation, not an event. It says the chain showed the loan repaid, defaulted, settled or closed by internal matching by a given block, and that when and how it ended was not recorded. It offers no transaction link and names no one who acted, because neither was seen, and the only time it shows is the time of the checked block. The entry sits in the feed in that block's order and opens the loan's page.

When the indexer cannot say whether any such entries exist, because the read failed or the answer was not in a shape the app recognises, the page now says a loan's ending may be missing instead of presenting the history as complete. A single malformed entry counts as not knowing, since keeping the rest would present a partial record as the whole one. Closes #2643.
