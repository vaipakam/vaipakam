## The cross-chain surplus reading now refuses to answer on the wrong deployment

Each supported network runs its own copy of the protocol, and one of them —
Base — keeps the ledgers that track how recycled reward funding is spread
across the others. A reading built on those ledgers reports whether a
particular network is sitting on more recycled funding than its recent usage
justifies.

That reading was available on every deployment, not just the one holding the
ledgers. Asked on any other network, it did not refuse; it read that
network's own empty copy and answered with zeros. Nothing distinguished that
from a real answer of "no surplus here" — the shape of the response was
identical, and there was no signal that the question had been put to a
deployment that could not possibly know.

A wrong number returned confidently is worse than a refusal, because whatever
reads it carries on and acts. This reading now refuses on any deployment other
than the one that owns the ledgers.

### Why the existing check did not already cover this

There was already a guard, and it is a different question. It refuses to
report on the network the deployment is *itself* running on, because a
network cannot hold a surplus relative to itself — the whole notion describes
funding that could move somewhere else. That check asks "is the network being
asked about a mirror?". The new one asks "should this deployment be answering
at all?".

Neither implies the other. The old guard passes happily on a mirror as long as
the network named in the question is some *other* mirror, which is exactly the
case that returned a confident zero. Both checks are now in place and both are
needed.

### What this does not change

Only this one reading is affected. Its neighbours were reviewed at the same
time and deliberately left alone: the ones that return raw ledger figures
already describe themselves as returning zeros away from Base, which is honest
about what they are, and at least one of them is genuinely meaningful on a
mirror because mirrors populate that particular record themselves. The reading
changed here is the one that composes several figures into a judgement and
presents the result as an assessment — which is what made an empty answer
misleading rather than merely empty.

Anything that was already asking this question of the deployment that owns the
ledgers sees no change.
