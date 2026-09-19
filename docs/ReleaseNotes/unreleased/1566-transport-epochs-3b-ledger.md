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

Each day keeps an arrival-ordered index of the epochs that list it, and a
cursor recording how far through that index its funding has been consumed. The
index exists because the older lane can produce arbitrarily many small
deliveries naming a single day; anything that had to walk all of them would
eventually stop fitting in a block, and an obligation would be blocked behind
funding that demonstrably exists.

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

Nothing here moves value yet. Deliveries that arrived before this ledger
existed keep behaving exactly as they did, no draw exists until the next
release adds one, and on a chain that has not received an old-wire delivery
none of this is reachable at all.
