### Cross-chain reward funding — specification caught up, and the allocation ceiling tested where it actually bites

The specification of how a chain's daily reward budget gets funded still
described the shape the platform had before recycling went cross-chain: the
canonical chain works out every chain's share and sends it. That has not been
the whole picture for several releases.

What is true now is narrower than "each chain funds itself", and the
distinction matters. A day's budget has two portions:

- the **scheduled portion**, its share of the fixed allocation, is still
  funded by the canonical chain for every chain. Local recycled value never
  substitutes for it, because it comes from a different pot;
- the **recycled portion**, sized from what each chain has absorbed, resolves
  in two passes: a chain funds its own recycled share from value it has
  itself absorbed and not yet spent, and only the shortfall draws on the
  canonical chain.

So a network where each chain roughly recycles what it pays out still
receives its scheduled portion centrally, while its recycled portion settles
locally and moves nothing across chains. The canonical chain is the top-up of
last resort for the recycled portion specifically — not for the whole share.

Two further behaviours were live but unstated at that level: a chain's funding
for a day waits on that chain's own report of what it owes for the day, and is
sized by it, so a day is never funded from a partial or missing picture — a
late report delays funding rather than zeroing it. And the one deliberate
exception, a day closed while a chain's activity was missing entirely, is
excluded from automatic funding on purpose, because that day's share was sized
without knowing the chain's real demand; an operator funds it separately
against evidence.

The specification also now states what the lifetime ceiling actually limits:
**drawdown from a balance set aside at launch**, not issuance. Nothing is
minted per claim, so calling it an issuance ceiling would hand anyone reading
downstream the wrong model of the token supply. Value recycled back into the
reward bucket is value the platform already received and is re-spending, so it
is not drawn from that allocation at all — which is why a day whose fresh
headroom is exhausted can still pay from the recycled bucket, and must, or the
recycling programme would end the moment the allocation was fully committed
rather than fully paid. The headroom counts value already *committed*, and
value already sent to another chain, as well as value already paid out: each
has spent that room even though the tokens may not have reached a claimant
yet, so no later day can size against it twice.

One older rule had to be superseded to say that cleanly. The specification
still carried a line stating that rewards must simply stop once the allocation
is exhausted — correct when the allocation was the only source of funding, and
directly contradictory now that a day beyond it can be funded from recycled
value. Extending the programme past the fixed allocation is what recycling is
for, so the old sentence read literally forbade the mechanism's whole purpose.
Rewards now stop when the allocation is exhausted *and* no recycled value is
available.

That headroom rule is where the accompanying test work went. The existing
check on it was an upper bound, and an upper bound is satisfied for free by
any state that never comes near it. The random-sequence campaign that
exercises this ledger cannot reach even two percent of the ceiling, so the
check was green because the boundary was unapproachable rather than because it
was enforced.

Three deterministic tests now place the ledger at the boundary directly:

- with a known amount of headroom left, the day's fresh funding must clamp to
  exactly that headroom instead of to its own schedule;
- with the allocation fully committed, the day must fund nothing fresh at all
  while still funding from the recycled bucket;
- and value already sent to another chain must reserve against the ceiling the
  same way — the one term no test could previously place at the boundary,
  since reaching it for real needs a chain to have been sent almost the whole
  allocation.

Each was confirmed against the change that would break it: sizing the
reservation from the unclamped schedule fails all three, while dropping the
already-sent term fails the third and only the third. Review also caught that
checking the day's *published* figure was not enough — the platform could
publish the clamped number and still reserve against the unclamped one, on
either the fresh or the recycled side — so the tests read the reservations
themselves, and each of those two omissions now fails a test.

Finally, the specification's testing requirements record what a cross-chain
test has to establish that a single-deployment test cannot. The properties
this layer adds are all *disagreements* between two ledgers on different
chains, updated by different transactions — a harness where one deployment
stands in for three cannot express a disagreement, so it cannot fail for the
reason that matters. Alongside that: the ordering guarantees a message
transport does not make, the two properties that are statements about a single
transition rather than about final state, and the requirement that the
continuous relations be checkable from public reads on a live deployment
rather than by replaying history.

Part of #1222 (stage B4-d), under the #1349 umbrella. This also settles which
tests evidence the cross-chain labelling work tracked under the closed #1331:
the receive path is exercised by the remittance ledger's own tests and made
observable by the published-counter relations, with the case of an arrival
never labelled at all left open as #1452. These boundary tests do **not**
evidence it — they exercise allocation-ceiling behaviour and never deliver a
remittance. The mirror-side half of that work describes behaviour that does
not exist yet and becomes reachable only with #1434.
