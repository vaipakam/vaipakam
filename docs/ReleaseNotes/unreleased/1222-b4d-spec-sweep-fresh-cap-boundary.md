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

Writing that down turned up two things the specification had wrong and one
the platform has wrong. An inactive day was described as having no recycled
portion at all, when in fact it has one funded centrally — what activation
changes is *who* funds it, not whether it exists. And the rule that recycled
value must never stand in for the scheduled portion turns out to be intent
rather than enforcement: a payout reduces the recycled ledger by its recycled
part and then pays the whole amount out of one pooled balance, so a chain
holding recycled value whose scheduled portion has not arrived can pay a
scheduled-only claim out of the tokens backing the recycled pool. Nothing is
paid to the wrong person, but the books stop being true — the recycled pool
claims more than it holds, and a later recycled claim fails instead of the
scheduled one having failed for want of funding. That is filed as #1460 and
must be closed before the recycled programme is switched on; the
specification now records the rule as intended-but-unenforced rather than
implying it holds today.

Two further promises elsewhere in the same specification rested on that rule
without saying so, and both are now qualified in the same terms. One said a
recycled claim never fails while a recycled budget stands — true of the
recycled term itself, but a recycled claim can still fail *later* if a
scheduled payout has already spent the custody behind that budget without
reducing it. The other said the reward bucket is always covered by real
custody, which is what backs the bounded keeper-incentive share carved from
inside it; that share is unbacked by exactly the same shortfall. Neither
statement was wrong about intent, and both would have read to someone
relying on them as a property that already holds.

So a network where each chain roughly recycles what it pays out still
receives its scheduled portion centrally, while its recycled portion settles
locally and moves nothing across chains. The canonical chain is the top-up of
last resort for the recycled portion specifically — not for the whole share.

Two further behaviours were live but unstated at that level: **once the
programme is armed**, a chain's funding for a day waits on that chain's own
report of what it owes for the day, and is sized by it, so such a day is never
funded from a partial or missing picture — a late report delays funding rather
than zeroing it. The "once armed" is not decoration: a day from before the
programme was switched on carries no such report to be sized against, and is
funded the older way without one. Written without that qualifier, this would
have someone waiting for a report an unarmed day never produces. And the one deliberate
exception, a day closed while a chain's activity was missing entirely, is
excluded from automatic funding on purpose, because that day's share was sized
without knowing the chain's real demand; an operator funds it separately
against evidence.

The specification also now states what the lifetime ceiling actually limits:
**drawdown**, not issuance. Nothing is minted per claim, so calling it an
issuance ceiling would hand anyone reading downstream the wrong model of the
token supply. It is equally not a balance that exists by virtue of deploying —
deployment mints a smaller initial amount elsewhere, and the balance claims
are paid from has to be funded into the platform separately. The practical
consequence is worth stating plainly, because it is the kind of thing found
the hard way: the platform can report ample headroom while holding nothing to
pay it with. Value recycled back into the
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

Five deterministic tests now place the ledger at the boundary. Three of them
place a single term there directly:

- with a known amount of headroom left, the day's fresh funding must clamp to
  exactly that headroom instead of to its own schedule;
- with the allocation fully committed, the day must fund nothing fresh at all
  while still funding from the recycled bucket;
- and value already sent to another chain must reserve against the ceiling the
  same way — the one term no test could previously place at the boundary,
  since reaching it for real needs a chain to have been sent almost the whole
  allocation.

Two further tests place those terms at the boundary **together**, because
each of the first three leaves only one of them non-zero — and a version of
the platform that took the larger of two reservations instead of adding them
produces exactly the right headroom in all three, passing every check. Only
a state carrying both at once separates the two, and it is an ordinary state
rather than a contrived one: value sent to another chain earlier, while one
of the main chain's own days is still open. Without it the platform could
have over-committed by the smaller of the two amounts on every such day,
invisibly.

The fifth adds the third term — value already paid out to claimants — for
the same reason one level up: with only the two commitment-side terms
present, a version that ignored what had already been paid, or that took
the larger of the two sides, still produced the right answer everywhere.
That one is not an edge case at all: once any claim has been paid, the
paid-out figure is non-zero for the rest of the programme's life, so the
surviving version would have over-committed on every day after the first
payout.

Each was confirmed against the change that would break it. The per-mutation
detail now lives in one place — a table beside the tests themselves — rather
than being restated here.

That is a deliberate change, and the reason is worth recording: three
successive reviews caught this description claiming a mutation was caught by
one fixture "and only that one", each time because a fixture had since been
added and nothing ties prose to the fixture set. Exclusivity is also the
wrong property to have been claiming — and so was the ordering criterion that
briefly replaced it, since the measured sets are not nested and so "fails while
the others pass" establishes nothing either. What makes a fixture worth keeping
is that it pins a distinct behaviour at the boundary and documents it, whether
or not another fixture happens to catch the same regression. Review also caught that
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
remittance. The half of that work concerning chains other than the canonical
one is only partly future: value arriving on such a chain is already labelled
and credited to its local pool today. What does not exist yet is that chain
pricing its own claims, and therefore settling or releasing what it has
committed — reachable only with #1434.
