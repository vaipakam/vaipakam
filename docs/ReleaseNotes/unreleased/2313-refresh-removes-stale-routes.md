## Thread — a complete in-place refresh now removes every function the code no longer has (PR #TBD)

When a function's signature changes, the Diamond gains the new function, but the old one keeps running the code it was last installed with until something removes it. The testnet in-place refresh used to remove these only from hand-kept lists, one per past incident, so any retirement nobody added to a list stayed callable. Base Sepolia carried eleven such functions through its complete refresh on 3 October:
- older shapes of the offer-accept entry points;
- two keeper-approval setters from before keeper permissions changed shape;
- four reward and acknowledgement receive hooks.

All eleven still ran pre-refresh code against current data. The deployment record also omitted the seven addresses they pointed at (#2313).

The refresh now works the other way round. After it installs the current functions and runs its one-time migrations, it asks the Diamond what it routes. It then removes every function outside the current deploy's set, names each one and where it pointed before it goes, and checks that each is gone. The hand-kept removal blocks are deleted. The one block kept is a migration that uses its retired function as a "not yet done" marker, and it removes that function itself. A Diamond that already routes exactly the current set sends no removal at all.

This matters for the reward-custody activation. The refresh records the Diamond's routing as it stands, and activation is refused on any other routing. Base Sepolia's record, taken on 3 October, included four retired reward receive hooks. Those are exactly the kind of route the record is meant to rule out, and the record cannot detect them: it proves only that nothing changed after it was taken. A refresh with this change removes them first, then records the routing.

The rule depends on the refresh's list of facets being complete. A facet missing from that list would now have its live functions removed, rather than left on old code as before. The existing deploy check that pins the refresh's function set to a fresh deploy's is what prevents that.

Base Sepolia is unchanged by this PR. Clearing its eleven routes and taking a new routing record needs one more refresh run under a pause. That run is the operator's decision.
