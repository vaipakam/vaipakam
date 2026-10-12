## Thread — the keeper indexes and proves every reward delivery's days on each mirror (#1944, transport epochs)

**Problem.** A reward-budget delivery that lands on a mirror funds the days it lists. The chain learns which days only when somebody supplies the list against the commitment the delivery stamped on arrival; nothing per day can be written at arrival, because the arrival's gas is already spent. Three permissionless steps do that work, and nothing ran them:
- indexing a delivery's epoch, page by page or chunk by chunk;
- proving a delivery that holds no epoch, by its whole list;
- proving a rooted delivery chunk by chunk.

Until an epoch's days are indexed its value funds nothing a claim can find. The mirror delivery gate also holds every funded day until its delivery is proven, so the runbook kept the gate dark: no keeper step existed.

**What changed.** The keeper has a new pass, armed by its own flag, that runs every few minutes on every mirror.
- **Finding deliveries.** It reads the chain's own record of recent budget deliveries from the indexer. Each delivery is joined to the event carrying its day list: the flat list itself, or the rooted wire's marker.
- **Flat lists.** For a delivery holding an epoch, it indexes the next page of the list until the index is whole. For one holding no epoch, it proves the whole list, unless every listed day has already landed.
- **Rooted lists.** It rebuilds the list from the canonical chain, following the runbook's rule: the reservation's day list, filtered to the days actually funded for this chain. It splits the list into chunks and builds the root with the wire's own encoding. It sends nothing unless that root matches both the reservation's and the delivery's. It then indexes, or proves, each chunk not yet landed, with that chunk's proof.

Every call is simulated first and moves no value. The wire encoding is checked against values computed independently, so an encoding drift fails a test rather than a proof on chain.

**Operator steps.** Arm the pass on every mirror before reward transport is live there. The delivery gate may then be armed on a mirror once the pass runs there. The restore runbook captures the new flag.

**Limit.** A day crowded with newer deliveries can need a position hint to be indexed. The pass does not compute hints yet: such a call is skipped and logged, and the day can still be indexed with a hint by hand.

Refs #1944, #1566, #1349.
