### Reward transport epochs — the epoch ledger (#1566 PR 3b-i)

A reward budget that reaches a mirror chain over one of the older wires
arrives as a single figure covering many days, with no statement of how much
of it was fresh funding and how much was recycled. Such a delivery has never
been spendable by the days it names: there is nothing on the wire to spend
against, and inventing a per-day split would assert a fact the delivery never
carried.

This release gives each of those deliveries its own **transport epoch** — one
untyped balance, with the days the delivery listed as a membership filter over
it. Only an obligation falling on one of those days may ever draw from it. The
balance is bounded by what actually landed rather than by what was declared, so
a short delivery shrinks the funding and never the obligations.

A delivery whose wire *did* carry the split takes none of this. Its components
were credited to the shared ledgers the moment it arrived, and giving it an
epoch as well would make one delivery spendable twice. The distinction is
supplied by the receiving contract, which is the only party that sees which
wire a message came off: by the time the figures reach the Diamond, a
wholly-recycled delivery on the new wire and a legacy delivery that stated
nothing look exactly alike.

Each day keeps an index of the epochs that list it, and a cursor recording how
far through that index its funding has been consumed. The index exists because
the older lane can produce arbitrarily many small deliveries naming a single
day; anything that had to walk all of them would eventually stop fitting in a
block, and an obligation would be blocked behind funding that demonstrably
exists.

Where an epoch sits in that index is not a statement about when its delivery
arrived. Writing the index is open to anyone and happens after the fact, so the
position an epoch ends up in records only who wrote it in first — and a
delivery brought in retrospectively (below) landed long before it was written
down at all. The index therefore reports each epoch's **own recorded arrival**
alongside it, taken from the delivery record and fixed when the delivery
landed. Anyone choosing between two epochs that fund the same day reads that,
rather than inferring an order from a list that was never ordered. Two
deliveries that landed in the same block share an arrival, which is the honest
answer: within one block there is no order to report.

For the same reason the sending side now refuses to build a remittance naming
more days than the destination can retire in one go. A message already sent
cannot be refused, though — the destination would reject the same message on
every retry — so an over-long delivery is accepted through a compact admission
that records only its total and its commitment to the day list. Its membership
is then written in bounded instalments, each proved against that commitment, so
the list a delivery is indexed under is always the list it actually claimed and
never one supplied afterwards by a caller.

Finally, what remains of such a delivery becomes available for reconciliation
only once its epoch is closed out in two recorded steps: the remainder is
parked under the delivery's own key, keeping the membership that binds it, and
then acknowledged. Both are required. An operator draining an epoch does not
thereby make its delivery reconcilable, and a late obligation whose day is in
the parked membership can still be funded from what was parked rather than
finding the value in a general pool it has no claim on.

Each reconciliation then draws the parked figure down by what it takes, so the
parked amount always states what is still there rather than what was once put
aside — and nothing can be reconciled beyond it.

An epoch is opened only where the delivery's value has somewhere to be
attributed. On a chain whose reward custody has not yet been switched on, an
arriving delivery's tokens rest with the platform itself and a later
switch-on is what assigns them; giving such a delivery an epoch as well would
have two records claiming the same money. Those deliveries behave exactly as
every delivery that predates this ledger does.

### Deliveries that landed before the ledger existed

An earlier release had already started recording, on every old-wire delivery,
a commitment to the day list it named — specifically so that a ledger arriving
later could index it. Between that release and this one there is a window in
which deliveries landed carrying that commitment but finding no ledger to join.

Those deliveries can now be brought in, by anyone, from their own delivery
record: the balance, the day list commitment and the day count are all read
from what was written when the delivery arrived, so whoever makes the call can
only cause the ledger to state what the platform already recorded. Nothing
about them is supplied by the caller. Once brought in they behave in every
respect like a delivery that arrived today — their membership is written in the
same instalments against the same commitment, and what remains of them becomes
reconcilable only through the same two-step close-out.

Without this they would have held value that no day could draw and that no
close-out gated, which is the opposite of what the commitment was recorded for.
Deliveries that arrived before that commitment was recorded have no day list to
be bound to and are unchanged; so are deliveries on a chain whose reward
custody has not been switched on, for the same reason as above.

### Operational note for the in-place refresh

The refresh that installs this work now upgrades the mirror's receiving
contract **before** it installs the new Diamond code, rather than after. In the
old order there was a gap in which a delivery could arrive at new Diamond code
through an old receiver, be accepted, and silently receive no epoch — bypassing
the close-out gate permanently. In the new order a delivery arriving in that
gap is refused outright and re-delivered once the refresh finishes, which costs
a retry and loses nothing. The refresh also now identifies that receiving
contract the way every other step does — by asking the platform which one it
actually uses, and treating the recorded address as a fallback — so a stale
record can no longer stop a refresh whose live receiver is perfectly fine.

Nothing here moves value yet: no draw exists until the next release adds one,
and on a chain that has not received an old-wire delivery none of this is
reachable at all.
