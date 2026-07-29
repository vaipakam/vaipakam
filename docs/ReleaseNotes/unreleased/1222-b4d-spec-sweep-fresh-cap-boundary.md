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

That last property is where the accompanying test work went. The existing
check on it was an upper bound, and an upper bound is satisfied for free by
any state that never comes near it — the random-sequence campaign that
exercises this ledger works in amounts seven orders of magnitude below the
ceiling, so the check was green because the boundary was unreachable rather
than because it was enforced. Two deterministic tests now place the ledger at
the boundary directly: with a known amount of headroom left, the day's newly
issued funding has to clamp to exactly that headroom instead of to its own
schedule; and with the allocation fully committed, the day has to fund no new
issuance at all while still funding from the recycled bucket. Both were
confirmed to fail when the committed-issuance term is dropped from the
reservation and when the clamp is removed — an implementation that quietly
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
