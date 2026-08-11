# P2-w6 — the recovery ceremony settles stranded value, and rotations carry open compensations (#1434 R6d/R6e)

A compensation whose message could verifiably never execute used to end
at "released": the day re-opened, but the chain's one-compensation-at-a-
time gate stayed held, waiting for the stranded tokens' fate to be
settled. That settlement now exists. When governance physically brings
the stranded value home, an evidenced ceremony record books it: the
recycled portion re-enters the platform's recycled custody under its own
provenance label, and the fresh portion lands in the same recovery
position that stranded returns feed — from which a replacement
compensation can be funded without charging the lifetime reward budget a
second time. Where part of the value is genuinely gone, governance
records that as explicit terminal loss. The gate releases only when
recovered value plus recorded loss account for everything the original
dispatch sent — partial recoveries keep it held, recording more than was
ever dispatched is refused, and a ceremony that claims tokens arrived
without them actually being present rolls back.

Replacing an earlier intent: recovery no longer "restores" spent budget
headroom. Keeping the lifetime figure permanently monotone and running
replacements uncharged from the recovery position is economically
identical, with one recovery pattern instead of two.

Deployment rotations can no longer silently forget an open
compensation. The outstanding-chain inventory is enumerable; the
rotation ceremony imports any still-open chain's gate onto the new
deployment, keyed to the old deployment's receipt. The imported gate
blocks new compensation dispatches for that chain until the old
delivery's fate is proven: a mirror can permissionlessly re-present its
receipt, and a consumed outcome releases the gate on the spot, while
anything else stays held for the operator's evidenced settlement,
which books whatever value physically came home as it releases the
gate.

A late confirmation that the original delivery did go through after all
now settles the chain by itself: the compensation funded what it was sent
for, so the gate opens and the chain can be compensated again. Where the
mirror's own reports contradict each other, nothing is taken on trust —
the gate stays shut until governance settles it with evidence, and any
recovery credit that the contradiction calls into question is frozen
rather than left spendable.

Recovered value is now tracked per original delivery rather than as one
undifferentiated pool. That matters when a delivery is later contradicted:
only the value still unspent from that particular delivery is frozen, so
one contradicted delivery can no longer consume the recovery capacity that
belonged to another. Value written off as permanently lost is recorded
with the same care as value recovered — both stop counting as still in
transit, so a written-off balance cannot go on appearing to back live
obligations.

Where a delivery's recovery is contradicted, the whole of its remaining
recovery entitlement is voided rather than only the part that could be
reclaimed at that moment — so it cannot quietly become spendable again
later out of value that belongs to a different delivery. And when
governance settles a compensation carried over from a retired deployment,
the recovered amount is booked against a freshly issued reference that the
replacement dispatch can actually name, so carried-over value does not end
up earmarked with no way to spend it.

Settling a compensation carried over from a retired deployment is bounded
by what that original delivery actually sent, recorded at the time it is
carried over — so a settlement cannot claim more than was ever at stake.
And if the old chain later reports that the original delivery went through
after all, the recovery credit that settlement created is voided, even
though the carry-over record itself has already been closed out.

What a carried-over compensation was worth is now established by reading
the retired deployment's own record rather than by anything the operator
types, and only the part that deployment had not already settled can be
carried. Each carried-over delivery can be brought across exactly once,
and the evidence that later voids its recovery is bound to the chain that
delivery belonged to — so no other chain can reach it.
