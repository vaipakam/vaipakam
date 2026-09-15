## #1566 closure 2 — the cutover apparatus, part two: the legacy reconciliation epoch (PR #TBD)

The first part of the cutover apparatus protected every untyped arrival
the moment it landed and recorded every packet under its transport
identity. This second part is what an administrator does with that
protected value: classify it, correct a classification, and reconcile the
inventory that arrived before packets were stamped. All of it is
administrator-only, under the platform's manual pause, on a deployment
whose custody is activated. A classification and a correction stay inside
the custody address — they move attribution and, where tokens move at
all, they move between the address's own rows, never from the platform's
own balance. The envelope import is the one entry that brings tokens in:
it relocates what still sits in the platform's own balance into the
address, measured at both ends, and pulls what the administrator funds
from the administrator, delta-checked, as the envelope paragraph below
states.

A classification takes part of what one recorded packet put into the
unclassified attribution and makes it fresh backing (what a standing
deficit absorbs goes to the restitution position, only the excess to live
backing), recycled backing, or both. It can never take more than the
packet put in — the packet's own remainder is the bound, which is what
protecting at ingress bought — and, on the fresh side, never more than
the packet's authenticated fresh figure: evidence the platform records
from the source chain's own account of the packet, which no administrator
writes. Until the change that carries that evidence lands, the figure is
zero, and an untyped packet classifies as recycled or stays where it is.
The recycled direction needs no evidence — fresh value classified
recycled under-publishes headroom, which the evidence-backed correction
lifts, whereas the reverse would spend someone else's backing first — so
a wrong split refuses at submission rather than being discovered after
it has published headroom. Each entry is applied once. A rounding residual
stays where it is, visible. A packet whose value is still reserved for a
return is not classifiable.

A classification is correctable, within a bound. Attribution moves between
the fresh and recycled sides of an entry without changing its total; only
what has not been spent moves freely, and a move toward fresh is bounded
by the same evidence as a classification, cumulatively over the packet's
entries. What is spent is what each outflow of a side's backing — live
fresh backing; the recycled backing — recorded against the classified
value, into the entry's own record, earliest first, the side's other
backing being counted as consumed first; the record is consulted, never
the backing's balance, and the work per outflow is bounded (stated
below), so a correction stays possible however long the record becomes.
Of a partly
spent entry the unspent part moves first, with its tokens, and only what
the corrected value can no longer cover moves as a debit: that order
gives exactly the ledger a correct split at ingress would have produced —
ten fresh with five paid out, two corrected to recycled, is eight fresh
with the same five paid and two unspent on the recycled side. A debit one
side inherited is unwound by the reverse move, so a correction and its
reversal leave an entry exactly as spent as it was. What each side's outflows took of the classified value is recorded at
the outflow itself, into that value's own record, earliest first, with
the kind of outflow — never read back from the backing's balance and
never inferred from totals, so a later credit un-spends nothing, a refill
is consumed once, and which classified value an outflow took, and how, is
known — and only the part the side's own ledger charged (paid on the
fresh side, consumed on the recycled side) may be inherited by the other
side: recycled value that left by a surplus repatriation, or whose payout
was later reversed (a released remit reverses exactly its own
consumption on exactly the value it took, no other's; the part a
correction had meanwhile moved to the fresh side is un-inherited by the
release — it returns to the entry's recycled side, spent and no longer
inheritable, the fresh side's received and paid figures falling together
— so the release gives up the remit's whole sent share and the coverage
allowance carries the full loss), and fresh
value a demotion unwound, are never inherited, and consumption made
while nothing classified was in the backing is nobody's. Value a
correction moves keeps its original place in the order. Recording what
an outflow took is bounded in work per outflow — the remainder is
carried and written by later steps that anyone may take, and a
correction waits for it — so no payout is ever held up by the record.
The one-time backfill of the released-remittance stranded figure that an
in-place upgrade needs completes across a correction: its completion
check states the same custody identity every checker states — a
correction's movements and a repatriation's included — so a legitimate
correction made before the ceremony runs no longer blocks it for good.
The mesh watcher reads a correction's two movement figures from the
reconciliation facet and states the same identity, and where it cannot
read them it reports the gap and leaves the two checks that need them
unrun rather than substituting zero. A view of the fresh side answers
only an era that exists.
Unspent value moves with its tokens only up to what the backing holds
beyond its standing commitments, on either side. The part of a classification that a standing deficit absorbed
into the restitution position is neither counted as spendable nor movable
for as long as that position holds it; what the position releases
of it — because a correction of the paid figure moved it back into live
backing, or because the deficit was paid with it — is recorded at the
release (a later credit to the position re-absorbs nothing) and re-enters
the record, earliest first, as unspent in the first case and spent in the
second. A correction of a recorded packet's entry moves that packet's
component figures with it. Unspent value moves with its tokens — out of
live backing only, never out of the restitution position; out of recycled
backing only up to what is not committed. Spent value moves as a debit
the other side inherits: fresh spent then corrected to recycled lowers
the delivered and paid figures together and raises the recycled
consumption, and the reverse raises them together and gives the
consumption back — never a demand for new capital, because an
authenticated ledger inherits the debit.

The inventory that arrived before packets were stamped is reconciled as
one aggregate, once. Every figure of it is read by the platform itself at
the import — what it counts as uncounted, less what the address already
holds of it, less the quarantine reservation still resting in its own
balance, less every return ever sent — and the administrator states only
how each unit is resolved: relocated from the platform's own balance where
the tokens are still there (measured at both ends, and as recycled backing
only — the inventory has no evidence source), funded by the administrator
where they are not (delta-checked into the address, as fresh or recycled;
the funded fresh is the only fresh the envelope can carry, and its later
correction is bounded by it), or written down. The resolution must be exact and the aggregate is then
entered into the same correctable record as every classification, so its
error path is the same correction. The epoch has no end: nothing here
closes it, by design.

One small correction to the refresh rides along: the remittance
receiver's generation probe now takes the live receiver before a stale
deployment record's distinct proxy, the order every other probe already
used, so a record naming a proxy the signer can no longer upgrade cannot
abort the run before the live receiver is reached.

Two things this part does not do, stated so they are not read as
forgotten. The epochs a role change carries in flight are a change of
their own, to land before the era registry that makes them consumable —
and they carry the evidence the fresh side waits on; and every entry keys
a single era until that registry assigns real ones. One thing about the
two parts together: they are one layout. No deployment carries the first
part's code alone, and the packet figures this part appends are recorded
together with the packet from the first refresh that carries them.
Refs #1566, #1349, #1956.
