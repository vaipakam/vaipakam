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

### Bringing an older delivery in costs what taking it back out costs

The call that brings a pre-ledger delivery into the ledger now takes the
delivery's own day list and checks it against the fingerprint recorded when
that delivery arrived. Anyone may still make the call, and nothing about the
delivery is taken from the caller's word — the list is checked, not believed,
and it is not stored.

The reason is a symmetry that was missing. Bringing a delivery in closes its
reconciliation gate: until that moment the delivery was reconcilable, and
afterwards it is reconcilable only once its remainder has been parked and
acknowledged — and parking requires the delivery's membership to have been
written, which requires that same day list. So without this check anyone could
close a gate that only someone holding the list could reopen. The deliveries
this entry exists to rescue are the oldest ones, whose day list may survive
only in long-past event records, so "it can be looked up" is not something the
platform can assume on every chain. Requiring the list up front also puts it
permanently in the record of the call that used it.

A delivery whose list does not match is refused and left exactly as it was —
still reconcilable, having lost nothing by the attempt.

### Who may close an epoch out

The close-out's two steps are open to different parties, because they are
different kinds of act.

Parking what a delivery's obligations left is **mechanical, and anyone may do
it**. It moves the delivery's own remainder into a holding of that same
delivery, under the same membership; nothing becomes spendable that was not
spendable before, and a valid delivery's close-out must never sit waiting on
whoever happens to hold the operator role.

Recording the acknowledgment is **an operator decision, and only the operator
may take it**. It is the platform choosing to stop waiting on a lane that
cannot prove its own closure, and it has a consequence somebody else bears:
obligations arriving afterwards for any of that delivery's listed days are
refused to the extent they looked to it. That is a claim written off on a
user's behalf and it cannot be undone. An earlier revision of this work opened
both halves on the reasoning that the specification calls the close-out
permissionless — it says that of parking, and of attesting a delivery's split,
and not of the acknowledgment.

### Reading what has left an epoch

The ledger now states, separately, how much has been reconciled out of a parked
remainder, alongside how much of it is left. The two are reported together
because neither is readable alone: a remainder parked at ten and reconciled for
four holds six, and six on its own cannot be told from a delivery that only
ever parked six. With both stated, anyone can check that a delivery's opening
figure still equals what it holds plus what has been parked plus what has left
— rather than having to infer the difference and hope.

### Operational note for the in-place refresh

The refresh that installs this work now cuts the facets that share the epoch
ledger's accounting — the one that opens an epoch, the one that spends from it,
and the one carrying the steps between — as **a single transaction**, rather
than letting them fall wherever the batching put them. Previously they could go
out several transactions apart, and in between the platform ran a mixed version
of one rule: new code opening an epoch while old code, still installed, reduced
the same delivery's unreconciled figure without touching that epoch — two
records claiming one amount. The window is now removed rather than narrowed:
before that transaction every participant is old and consistent, after it every
participant is new and consistent, and there is no state in between for a
delivery or an operator to land in. A group that outgrew a single transaction
would stop the refresh before it started rather than split silently.

The refresh also upgrades the mirror's receiving contract **before** it installs
the new Diamond code, rather than after. In the old order there was a gap in
which a delivery could arrive at new Diamond code through an old receiver, be
accepted, and silently receive no epoch — bypassing the close-out gate
permanently. In the new order a delivery arriving in that gap is refused
outright and re-delivered once the refresh finishes, which costs a retry and
loses nothing. The refresh identifies that receiving contract the way every
other step does — by asking the platform which one it actually uses, and
treating the recorded address as a fallback — and a failure to upgrade the
recorded one is now reported loudly and carried past rather than aborting the
run: the live receiver is the one that must succeed, a stale record is not, and
a receiver left behind fails closed on its next delivery rather than losing
anything.

Nothing here moves value yet: no draw exists until the next release adds one,
and on a chain that has not received an old-wire delivery none of this is
reachable at all.
