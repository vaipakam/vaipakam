# P2-w6 — stranded compensation value gets a settlement, and rotations carry open compensations (#1434 R6d/R6e)

A compensation whose message could verifiably never execute used to end at
"released": the day re-opened for funding, but the chain's
one-compensation-at-a-time gate stayed held, waiting for the stranded
tokens' fate to be settled. Nothing existed to settle it. That settlement
now exists.

## Recovering stranded value

When governance physically brings stranded value home, an evidenced
ceremony records it. The recycled portion re-enters the platform's
recycled custody under its own provenance label; the fresh portion lands
in the same recovery position that stranded returns feed, from which a
replacement compensation can be funded without charging the lifetime
reward budget a second time. Where part of the value is genuinely gone,
governance records that as explicit terminal loss, split by provenance the
same way.

The gate releases only when recovered value plus recorded loss account for
everything the original dispatch sent. Partial recoveries keep it held,
recording more than was ever dispatched is refused, each component is
bounded by what that delivery actually sent of that kind, and a ceremony
claiming tokens arrived without them actually being present rolls back.

Recovery is tracked **per original delivery**, not as one undifferentiated
pool. This matters when a delivery is later contradicted: only the value
still unspent from that particular delivery is frozen, so one contradicted
delivery can never consume recovery capacity belonging to another — which
that other delivery could not re-earn, its own entitlement being spent.
When a contradiction does occur, the whole of that delivery's remaining
entitlement is voided, not merely the part reclaimable at that instant, so
it cannot quietly become spendable again out of value belonging to someone
else.

Value written off as permanently lost is recorded with the same care as
value recovered: both stop counting as still in transit, so a written-off
balance cannot go on appearing to back live obligations. Value that
returns late is credited only up to what has not already been recovered or
written off, so what is recovered plus what was written off can never
exceed what was originally sent.

*Replacing an earlier intent:* recovery no longer "restores" spent budget
headroom. Keeping the lifetime figure permanently monotone and running
replacements uncharged from the recovery position is economically
identical, with one recovery pattern instead of two.

## Rotations

A deployment rotation can no longer silently forget an open compensation.
The outstanding-chain inventory is enumerable, and the rotation ceremony
carries any still-open chain's gate onto the new deployment, keyed to the
old deployment's receipt. Each open delivery can be carried across exactly
once.

The carried gate blocks new compensation for that chain until the old
delivery's fate is proven, and only the operator's evidenced settlement
proves it. There is deliberately no permissionless release. The record the
gate is keyed to is one the operator typed in by hand, and nothing on the
new deployment can check that it names the delivery genuinely outstanding
rather than some unrelated, already-settled one — so an attestation
"verified" against it would prove only that the operator was consistent,
while the real delivery stayed live and both it and its replacement backed
the same claims. Stating the release as the governance act it actually is
keeps a mistyped import to a liveness problem, recoverable by correcting
the entry, instead of a funding one.

**A carried-over settlement creates no spending capacity of its own.** It
releases the block, and recycled value that physically came home re-enters
platform custody; anything else remains ordinary custody. A replacement
compensation is then funded through the normal charged path, which
correctly counts against *this* deployment's lifetime budget rather than
assuming an earlier deployment's accounting carries across — it does not.
The consequence is that a mistaken carry-over costs only availability on
the one chain it names, and never value.

## Late confirmations

If a released delivery turns out to have been consumed after all, that
settles the chain by itself: the compensation funded what it was sent for,
so the gate opens and the chain can be compensated again, and the funding
accounting the release had unwound is re-closed — otherwise a replacement
could be funded against a quota the original already met.

Where a mirror's own reports contradict each other, nothing is taken on
trust. The gate stays shut until governance settles it with evidence, and
any recovery credit the contradiction calls into question is frozen rather
than left spendable.
