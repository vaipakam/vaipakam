## Keeper — new and re-priced offers are matched first

The keeper's offer matcher now looks at new and re-priced offers before its ordinary walk of the book. An offer created or re-priced in the last ten minutes, and old enough for the protocol's terms-age rule, is previewed against the offers resting in its own bucket at the start of the next matcher run. Before this, a new offer waited until the rotating walk happened to reach its pair, which on a large book could take several runs.

This first look cannot take the walk's turn. It may spend at most a fixed share of each run's previews, matches and time: a quarter by default, set by the plain var `MATCHER_FRESH_LANE_SHARE` (0 turns it off, half is the most allowed). The walk keeps the rest of the run whether or not that share was used, and it skips pairs the first look already previewed. So the walk never has less than three quarters of what it had before, and a test shows a resting pair elsewhere in a busy book is still reached within the same number of runs as without the lane.

Each offer gets this priority once for its creation. A re-price earns it again only an hour after the offer last had it, so re-pricing an offer over and over cannot keep it at the front. Inside the first look the pairs are walked in the same creator-pair turns as the ordinary walk, so one wallet posting many offers at once counts as one counterparty.

The keeper remembers which offers already had their turn only while it runs. After a restart, an offer changed in the last ten minutes may get one more turn, which costs at most one share of a run.

Advances #3622 (part B2). Design: IdleLiquidityMatchingDesign.md section 3, B2. No contract change.

> Caveat: the walk keeps at least (1 − share) of each run's budget rather than all of it, so on a book larger than one run can cover, the ordinary walk can need slightly more runs to reach every pair than before; at the default share the test book above still needs no more runs.
