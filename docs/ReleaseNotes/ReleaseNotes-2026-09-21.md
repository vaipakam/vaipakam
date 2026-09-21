# Release Notes — 2026-09-21

Two merges today. The larger one is the third transport-epochs release of the
#1566 programme (PR #2232): every reward-budget delivery that reaches a mirror
over one of the older wires now gets its own epoch in the ledger — a single
untyped balance bound to the days the delivery named — and the close-out that
would let such a delivery be reconciled early is deliberately not offered yet
(owner decision on #2258). Nothing draws from an epoch in this release; the
draws are the next one. The smaller merge (PR #2266) closes a latent
inconsistency in the deploy tooling, where four scripts built a per-chain
artifact path by hand instead of through the redirectable root the rest of the
tooling follows.

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
wire a message came off. By the time the figures reach the platform, a new-wire
delivery small enough that both of its components round away to nothing looks
exactly like a legacy delivery that stated nothing — both arrive as a pair of
zeros. (A delivery that was *wholly* recycled is not one of these: it arrives
stating its whole amount as recycled, which is unmistakable.)

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

Finally, what remains of such a delivery is meant to become available for
reconciliation only once its epoch is closed out in two recorded steps: the
remainder is parked under the delivery's own key, keeping the membership that
binds it, and then acknowledged. Both are required — and **in this release
neither is offered**. The close-out entries exist so the surface keeps its
shape, but every call to them is refused, for the operator as much as for
anyone else. The design says a delivery may be closed out only once every
obligation on the days it listed has settled, and this release has no way to
test that; a close-out the platform cannot check would be an earmark spent on
the caller's say-so. The release that adds per-day obligation tracking is the
one that opens these entries. Until then an epoch's value stays in its
membership-bound holding, visible in the ledger, and cannot be reconciled early
by anyone. It also cannot be **classified** — neither as fresh nor as recycled
— because classifying what a delivery holds is gated on the same close-out that
is not offered. So a delivery holding an epoch is, in this release, wholly
untyped: nothing of it moves, and nothing of it is lost. (Owner decision,
recorded on issue #2258.) An operator draining an epoch does not
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

### Bringing an older delivery in takes the delivery's own day list

The call that brings a pre-ledger delivery into the ledger now takes the
delivery's own day list and checks it against the fingerprint recorded when
that delivery arrived. Anyone may still make the call, and nothing about the
delivery is taken from the caller's word — the list is checked, not believed,
and it is not stored.

The reason is that this call is where the delivery's opening figure is fixed,
permanently. A membership that can never be produced would leave that figure
describing a set nobody can enumerate. It costs a caller nothing it does not
already need: writing the membership checks the same list against the same
fingerprint, so there is no route to a close-out without it. Requiring the list
up front also puts it permanently in the record of the call that used it, which
matters because the deliveries this entry exists to rescue are the oldest ones,
whose day list may survive only in long-past event records.

An earlier draft of this release gave a different reason — that bringing a
delivery in was what *closed* its reconciliation gate, so it had to cost what
reopening it cost. That is no longer how the gate works, as the section below
describes: a delivery owed a place in the ledger is gated from the moment it
lands, and bringing it in closes nothing. The reason is restated here rather
than left standing next to a section that contradicts it.

A delivery whose list does not match is refused and left exactly as it was,
having lost nothing by the attempt.

### Who may close an epoch out — once the close-out is offered

**Neither of the two steps below can be performed on this release.** Both
entries refuse every caller, the operator included; the close-out arrives with
the follow-up. This whole section describes the rule each step **will** carry
when it opens, and it is written down now because the rule is what the two
halves were separated for. Nothing here is an instruction for today.

The close-out's two steps are open to different parties, because they are
different kinds of act.

Parking what a delivery's obligations left will be **mechanical, and open to
anyone**. It moves the delivery's own remainder into a holding of that same
delivery, under the same membership; nothing becomes spendable that was not
spendable before, and a valid delivery's close-out must never sit waiting on
whoever happens to hold the operator role.

Recording the acknowledgment will be **an operator decision, and only the
operator may take it**. It is the platform choosing to stop waiting on a lane that
cannot prove its own closure, and it has a consequence somebody else bears:
obligations arriving afterwards for any of that delivery's listed days are
refused to the extent they looked to it. That is a claim written off on a
user's behalf and it cannot be undone. An earlier revision of this work opened
both halves on the reasoning that the specification calls the close-out
permissionless — it says that of parking, and of attesting a delivery's split,
and not of the acknowledgment.

### A delivery that can still be brought in is not an ungated one

The close-out gate asks whether a delivery holds an epoch. A delivery that
arrived before the day-list fingerprint was first recorded holds none and never
can — there is no membership an epoch could be bound to — so it was reconcilable
as it always had been. That much was correct; what went wrong was the
boundary. The rule was applied to everything that landed before this ledger
existed, which is a wider population: a delivery from the window described above
holds no epoch **yet**:
it carries the day-list commitment, and anyone can bring it in at any time. Read
as though it were pre-ledger, it could be reconciled away first — with no
close-out and nothing drawn down — which is the bypass the gate exists to
prevent, surviving on precisely the population the retrospective entry exists to
rescue.

The two are now told apart by the same test that decides whether the
retrospective entry would accept the delivery, so they cannot answer
differently. A delivery that entry would still accept must be brought in and
closed out before it can be reconciled, and the refusal says so and names the
missing step. A delivery it would refuse can never hold an epoch, and is
reconcilable exactly as before.

**What this costs, stated plainly.** Bringing a delivery in requires producing
its day list, so a delivery whose list can no longer be produced can no longer
be reconciled, where before this it could. Nothing is lost: the value stays
exactly where it already is, held aside and unreconciled, and it becomes
reconcilable the moment someone produces the list. That is the conservative
direction, and the alternative is reconciling value while the days that
delivery named can still draw on it.

### One plan for the send and every quote

A reward remittance and the three views that describe one — the discovery
view an operator sizes a batch from, the per-day plan view, and the fee quote —
used to each walk the day list on their own, and each walk enforced a different
subset of the rules. Three times in this programme a quote priced a batch the
send would then refuse, and each time the rule had been added to one walk and
not another. There is one walk now. The send plans its batch with it and then
applies the writes; the fee quote refuses exactly what the send refuses, in the
same order; the two discovery views report the same per-day figures the send
would fund. A rule added once applies everywhere, and the four cannot disagree
because they run one piece of code. The discovery view keeps its tolerant
reading — a day that cannot be remitted shows as zero rather than failing the
call — because the automation that scans for fundable days depends on that;
what it no longer does is imply the send would accept the whole list. A
remittance funds at most thirty-two days, and the number of days a list would
fund is the count of non-zero per-day figures; the operations runbook now says
so beside the lane cap.

### Reading what has left an epoch

The ledger now states, separately, how much has been reconciled out of a parked
remainder, alongside how much of it is left. The two are reported together
because neither is readable alone: a remainder parked at ten and reconciled for
four holds six, and six on its own cannot be told from a delivery that only
ever parked six. With both stated, anyone can check that a delivery's opening
figure still equals what it holds plus what has been parked plus what has left
— rather than having to infer the difference and hope.

**A reading about a delivery the ledger has never heard of is refused, not
answered with zeros.** Asking what a delivery's transport legs have spent, or
what it has parked, used to return zeros for an identifier no delivery ever
opened — the same zeros a real delivery that has spent nothing and parked
nothing returns. The two are not the same statement: one is a figure, the other
is the ledger having nothing to say, and these particular figures are half of
the evidence a close-out's ceiling is read from. A mistyped or stale identifier
could therefore be presented as substantiated evidence that nothing had been
drawn. Both readings now refuse an unrecognised identifier by name, in the same
words the writing operations already use for it. One reading still answers, by
design: the one that reports the delivery's epoch as a whole is how a caller
asks whether the ledger knows an identifier at all, so it has to stay callable
on one it does not.

### The one other way protected value leaves, and why it cannot reach an epoch

There is a second route by which a delivery's held-aside value can leave
without being reconciled: a compensation that arrived unusable is quarantined
and later returned home to the chain that sent it. That route does not consult
the epoch ledger at all — it reduces the delivery's unreconciled figure
directly. Had the two ever met on one delivery, a return would have left its
epoch promising the days it named more than the delivery still held: a figure
that could never be worked down, and, once the days can draw, a draw against
value that is no longer there.

They cannot meet, and this release says so where it matters and pins it with a
test. Only a compensation arrival is ever returnable, and a compensation always
states its whole amount as one named component — which is precisely the shape
that is refused an epoch, because a delivery with named components had them
credited on arrival. So the guarantee holds today, but it holds on a decision
made by the ARRIVAL rules rather than by the epoch ledger, which checks nothing
of the sort. Changing how a compensation states its amount would reopen the
route silently. That dependency is now written into both surfaces and asserted
by a regression test, so it fails loudly instead.

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
outright, and nothing about it is lost — but **the recovery is not automatic**.
The transport records a refused delivery as a failed message that an operator
must re-execute by hand once the refresh has finished; it is not redelivered on
its own. Completing the refresh and waiting is therefore not enough, and any
delivery that landed in the gap is still carrying its tokens until someone
re-executes it. The refresh identifies that receiving contract by asking the platform which one
it actually uses. The separately recorded address is **not a stand-in for
that**: it is only a second contract the refresh will try to upgrade, so that a
changeover in progress leaves neither the outgoing nor the incoming one behind.
A deployment that receives deliveries but has no receiving contract registered
with the platform is stopped, and a recorded address cannot make that refresh
complete — the recorded one is a note about which contract to upgrade, never
evidence about which one the platform will accept deliveries from. A failure to
upgrade the recorded one is reported loudly and carried past rather than
aborting the run: the live receiver is the one that must succeed, a stale record
is not, and a receiver left behind fails closed on its next delivery rather than
losing anything.

The stop applies to the deployments that actually receive deliveries. A
single-chain deployment, and one that has been detached from the mesh, receive
none, so neither is asked for a receiving contract.

Not being asked for one is not the same as not having one, and detaching does
not by itself clear anything. Detaching changes the deployment's role; whatever
receiving contract was registered stays registered until an administrator
clears it in a separate, deliberate act. The refresh keeps upgrading any
registered receiver it finds, whatever the role — so a detached deployment that
kept its old one is still carried forward, and an operator reading the
remaining configuration should not take the detachment as evidence that the
pointer is gone.

The refresh additionally **retires the old delivery entry points before the
first cut**, not after the last one. Retiring them is what makes an
un-upgraded receiver's delivery fail outright instead of half-succeeding, and
doing it last left the whole refresh window open to the case the receiver
upgrade cannot reach: an older mirror where the platform cannot say which
receiving contract it uses and the recorded address is missing or stale. There
is no receiver to upgrade there, so nothing could close the window by
resolving one — closing it structurally does. From that first transaction on, a
delivery through any receiving contract that has not been upgraded is refused,
whether or not the refresh ever identified it, and is then re-executed by hand
afterwards — again, not automatically. The
same retirement runs again at the end, where it is now the sweep for a run
interrupted in between.

### Keeping a funding batch inside what a delivery can carry

This release introduces a limit on how many days one delivery may name, and
**the limit is enforced at the source**: both the send and the fee quote for it
refuse a delivery whose day list runs past the bound, so an over-long batch is
turned away before anything leaves — and the quote refuses exactly what the
send would, so no fee is ever priced for a delivery that cannot be made.

The destination does **not** apply that limit, and the distinction matters when
recovering an old message. A transport payload is immutable, so refusing one at
the destination would refuse the same message on every re-execution and strand
it for good. An already-dispatched delivery naming more days than the limit
allows is therefore accepted: it is admitted compactly, and its day list is
written in pages afterwards, exactly as any other delivery's is. Nothing about
the new limit makes such a delivery unrecoverable.

The automated funding pass builds those deliveries, and it sized them only by
the amount of VPFI they move. Those two limits come apart exactly when it
matters: after an outage, or a run of delayed source reports, many days are
owed at once, each carrying a small amount. The total sits comfortably inside
the monetary limit while the day list runs far past the day bound — so every
attempt was refused at the source before anything was sent, and the next
attempt rebuilt the identical batch. A mirror in that state would have stayed
unfunded indefinitely, with nothing in the ledger to show why.

The pass now stops at the day bound and reports the rest as
deferred, exactly as it already does when the monetary limit binds: the mirror
is reported as not fully funded, and the next pass takes the next instalment,
so the backlog drains instead of wedging.

The limit counts the days that actually carry funding. Days that are only
being closed out are left out of what the destination receives, so they are
outside the limit and ride along freely — the same treatment they already get
from the monetary limit. Counting them would have refused batches the send
accepts, and would have let a plan made up mostly of close-outs fill the limit
with them and then quietly leave funded days behind while reporting the mirror
complete.

Nothing here moves value yet: no draw exists until the next release adds one,
and on a chain that has not received an old-wire delivery none of this is
reachable at all.
<!-- assembled-fragment: 1566-transport-epochs-3b-ledger.md sha256=cbd1b0c4112310dd97f8242586ca044bd303da1443058f426097fc76911e5c95 -->

## Thread — four deploy scripts were writing and reading outside the redirect they were supposed to follow (PR #2266)

Deployment tooling records what it did in a per-chain folder of the repository — the address inventory other tooling reads, plus a few ceremony receipts alongside it. A recent change made that folder redirectable, so a test can run a real script end to end without overwriting the committed record. The redirect is consulted in one place, and every path helper was supposed to reach it.

Four scripts did not. Two wrote ceremony receipts and two read the address inventory, and all four built the folder path themselves from a fixed string. Under a redirect they ignored it: the two writers would have dropped their receipts into the committed folder while everything else from the same run went to the scratch one, and the two readers would have configured a redirected rehearsal against addresses belonging to a different deployment altogether. Nothing drives those scripts under a redirect today, so this was a latent inconsistency rather than an observed failure — but it is the kind that surfaces the first time someone writes the test that would have caught it.

All four now go through the shared helpers, and the helpers themselves were re-layered so exactly one function decides where artifacts live; everything else, including a new form for "a named record beside the address inventory", is built on top of it. One of the four resolves its chain from an operator-set name rather than from the chain it is connected to, which is why there is a second entry point taking that name — rebuilding the root by hand to serve that case is precisely how these four drifted out.

The accompanying tests cover the helpers directly and two of the four call sites — the ceremony receipt and the refresh reader — each through a probe, and each verified by restoring the fixed string in isolation and watching the matching test fail. The remaining call site, in the handover script, is not covered: it is internal to a script that cannot carry a redirect at all, so a probe would have to grant it a capability it does not have and would end up asserting its own wiring. It is correct by construction — the hand-built root is gone — and that is the claim being made for it.

A first version of this change made that same excuse for the refresh reader, and the excuse was false: that script inherits the redirect capability already, so a probe needed nothing special and the test was simply missing. Review caught it. The distinction matters more than the one test does, because an unfounded reason not to test something reads exactly like a sound one, and stops anyone looking again.

Review also found that the change had quietly reopened something an earlier one had closed. The redirect is confined by two checks on the destination root, and the reasoning recorded alongside them is that nothing satisfying both can climb back out to the committed folder. That reasoning is about the finished path, but it had only ever examined the root — and the new helper appends a second caller-supplied piece, the chain name, which one script reads from an environment variable. A chain name containing the usual step-up-a-directory notation therefore walked straight back to the committed inventory the redirect exists to protect. The same check now applies to both pieces, and it is one shared check rather than a copy per site, since a copy is how the two halves of a single rule drift apart.

Worth recording because the comment was load-bearing and wrong: the note on the existing path helper stated that every artifact path in the library was built there. It was not, in two separate ways, and it had been read as assurance. It now says where the single place actually is and names what had been sitting outside it.

Closes #2261.
<!-- assembled-fragment: 2261-artifact-path-rooting.md sha256=9ed25ce27c4e2f02feebdeb170323cd55393020c254542e619ffa3820ccdf43b -->
