## Thread — the reward-mesh role becomes a recorded fact, not an inference (#1566)

A chain's role in the reward mesh used to be worked out from two configuration
values: it was a "mirror" if it was not marked canonical and it named a
canonical chain. That leaves a case the expression has no answer for — a chain
that is neither. Fourteen places in the reward code asked that one question and
each decided two different things from the answer (am I bounded, and do I
record what I pay), so the unhandled case failed in two directions at once. A
chain in it was treated as unbounded for the purpose of paying rewards out,
while every writer that tracks what has been paid went quiet.

Naming that state is not enough on its own, and this change is mostly about
why. The condition "not canonical and no canonical chain named" does not
describe one situation but two, and they need opposite treatment. A chain that
*was* in the mesh and was later detached from it has already spent funding it
cannot earn back, so it has to stop paying. A chain that was simply never put
into the mesh is an ordinary single-chain deployment with nothing delivered to
it, nothing owed, and nobody to report to — it has always operated normally and
must continue to. From the outside the two are indistinguishable: the stored
values are byte-for-byte identical.

This is not a hypothetical distinction. Reading the live configuration of every
deployed chain while preparing this work found two of them — the Arbitrum
Sepolia and BNB testnet deployments — sitting in exactly that state today.
Treating the state as "detached" and failing closed, which is what the design
called for before this correction, would have frozen every reward consumer on
both.

So the role is now **recorded when it is set** instead of being reconstructed
afterwards. The two administrative actions that can change a chain's role are
the only way into the detached state, and both now note that the chain has been
placed in a role at all. That single piece of information is what separates
"detached" from "never configured", and because it is written at the moment of
the change rather than deduced later, the four roles are exhaustive by
construction. Existing deployments need no migration: a canonical or mirror
chain resolves on its own terms regardless, and a chain still sitting at its
defaults genuinely is unconfigured.

The delivered-funding bound now answers for all four roles from one place, and
several call sites that re-derived the role locally were collapsed into asking
it. That is not a tidy-up: each of those sites was a place where a role could
be honoured in one branch and missed in another, and one of them was the
fail-open path itself. Because the bound already answered correctly for the
roles those branches were protecting, removing them changes nothing for
canonical, mirror and unconfigured chains while closing the gap for detached
ones.

Finally, the resolved role is now readable on-chain. The raw configuration
values are not sufficient to determine it — that is the whole point — so an
operator inspecting a deployment previously had no way to tell the two
ambiguous states apart. Neither did the code, which is how this defect lasted.

Scope note: this lands the role resolver and the detached-chain behaviour that
needs no further machinery. The refinements that draw on retired-era balances
and prepared transport coverage arrive with the funding work they depend on;
until then a detached chain bounds at zero, which is the safe direction and is
unreachable on any chain deployed today.

Refs #1566, #1349, #1956
