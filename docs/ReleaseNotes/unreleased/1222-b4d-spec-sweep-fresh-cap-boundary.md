### Cross-chain reward funding — specification caught up, and the issuance cap tested where it actually bites

The specification of how a chain's daily reward budget gets funded still
described the shape the platform had before recycling went cross-chain: the
canonical chain works out every chain's share and sends it. That has not been
the whole picture for several releases. On a day where recycling is active,
each chain now funds its own share first out of value it has itself absorbed
and not yet spent, and the canonical chain only covers what is left over — so
a network where each chain roughly recycles what it pays out settles with
almost no cross-chain movement at all, and the canonical chain is the top-up
of last resort rather than the funder of first resort.

Two further behaviours were live but unstated at that level: a chain's funding
for a day waits on that chain's own report of what it owes for the day, and is
sized by it, so a day is never funded from a partial or missing picture — a
late report delays funding rather than zeroing it. And the one deliberate
exception, a day closed while a chain's activity was missing entirely, is
excluded from automatic funding on purpose, because that day's share was sized
without knowing the chain's real demand; an operator funds it separately
against evidence.

The specification also now states plainly that the lifetime issuance ceiling
bounds newly issued value only. Value recycled back into the reward bucket is
being re-spent rather than newly created, so a day whose issuance headroom is
exhausted can still pay from the recycled bucket — and must, or the recycling
programme would end the moment the allocation was fully committed rather than
fully paid. The headroom counts value already *committed* as well as value
already paid: a day that has committed issuance has spent that room even
though no tokens have moved, so no later day can size against it twice.

One older rule had to be superseded to say that cleanly. The specification
still carried a line stating that rewards must simply stop once the
allocation is exhausted — correct when the allocation was the only source of
funding, and directly contradictory now that a day beyond it can be funded
from recycled value. Extending the programme past the fixed allocation is
what recycling is for, so the old sentence read literally forbade the
mechanism's whole purpose. Rewards now stop when the allocation is exhausted
*and* no recycled value is available.

Two wording corrections came out of review and are worth recording because
both would have misled a reader in a way the code does not. The scheduled
portion of a day's budget is still funded centrally for every chain — only
the recycled portion resolves locally first — and an earlier draft implied a
chain with enough recycled value funds its whole share alone. And the
allocation ceiling limits *drawdown from a balance set aside at launch*, not
issuance: nothing is minted per claim, and describing it as an issuance
ceiling would give anyone reading downstream the wrong model of the token
supply.

That last property is where the accompanying test work went. The existing
check on it was an upper bound, and an upper bound is satisfied for free by
any state that never comes near it — the random-sequence campaign that
exercises this ledger works in amounts seven orders of magnitude below the
ceiling, so the check was green because the boundary was unreachable rather
than because it was enforced. Two deterministic tests now place the ledger at
the boundary directly: with a known amount of headroom left, the day's newly
issued funding has to clamp to exactly that headroom instead of to its own
schedule; and with the allocation fully committed, the day has to fund no new
issuance at all while still funding from the recycled bucket. A third case covers value already sent to another chain, which reserves
against the ceiling the same way and was the one term no test could
previously place at the boundary — reaching it for real needs a chain to have
been sent almost the whole allocation. All three were confirmed to fail when
the committed term is dropped from the reservation and when the clamp is
removed, and the third additionally when the already-sent term is dropped.
Review also caught that checking only the published figure for the day was
not enough: the platform could publish the clamped number and still reserve
against the unclamped one, so the tests now read the reservation itself — an implementation that quietly
ignored open commitments, or that zeroed the whole day rather than just its
issuance half, fails here and passes everything else.

Finally, the specification's testing requirements now record what a
cross-chain test has to establish that a single-deployment test cannot. The
properties this layer adds are all *disagreements* between two ledgers on
different chains, updated by different transactions — a harness where one
deployment stands in for three cannot express a disagreement, so it cannot
fail for the reason that matters. Alongside that: the ordering guarantees a
message transport does not make, the two properties that are statements about
a single transition rather than about final state, and the requirement that
the continuous relations be checkable from public reads on a live deployment
rather than by replaying history.

Part of #1222 (stage B4-d), under the #1349 umbrella. Also records that the
cross-chain labelling work tracked under the closed #1331 is covered by these
tests on the canonical side; its mirror-side half describes behaviour that
does not exist yet and becomes reachable only with #1434.
