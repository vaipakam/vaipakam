# Release Notes — 2026-09-21

Four behaviour-changing merges today, in two unrelated strands. Two further
merges landed the same day and are not written up below: PR #2265 and PR #2273
were release notes themselves.

**The off-chain database moved.** The shared store the indexer, keeper and
agent all read was carried from one database to another, and the two sections
at the end of this file describe the halves of that: holding the writers still
long enough for the copy to describe a single moment (PR #2280), and the move
itself (PR #2267). The retained database is kept and keeps being compared
against the new one, because work suspended across the move can commit
afterwards — so the record that comparison runs against, and the way back it
licenses, are the subject of the next day's notes.

**And the reward-transport work continued.** The larger of those is the third
transport-epochs release of the
#1566 programme (PR #2232): on a mirror whose reward custody has been
switched on, every reward-budget delivery that arrives over one of the older
wires now gets its own epoch in the ledger — a single untyped balance bound
to the days the delivery named (a delivery landing before the switch-on takes
none, and is assigned by the switch-on itself, as the section below says) —
and the close-out that
would let such a delivery be reconciled early is deliberately not offered yet
(owner decision on #2258). Nothing draws from an epoch in this release; the
draws are the next one. The smaller merge (PR #2266) closes a latent
inconsistency in the deploy tooling, where four scripts built a per-chain
artifact path by hand instead of through the redirectable root the rest of the
tooling follows.

## Thread — reward transport epochs, the epoch ledger (#1566 PR 3b-i, PR #2232)

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

The accompanying tests cover the helpers directly and two of the three call sites — the ceremony receipt and the refresh reader — each through a probe, and each verified by restoring the fixed string in isolation and watching the matching test fail. The remaining call site, in the handover script, is not covered: it is internal to a script that cannot carry a redirect at all, so a probe would have to grant it a capability it does not have and would end up asserting its own wiring. It is correct by construction — the hand-built root is gone — and that is the claim being made for it.

A first version of this change made that same excuse for the refresh reader, and the excuse was false: that script inherits the redirect capability already, so a probe needed nothing special and the test was simply missing. Review caught it. The distinction matters more than the one test does, because an unfounded reason not to test something reads exactly like a sound one, and stops anyone looking again.

Review also found that the change had quietly reopened something an earlier one had closed. The redirect is confined by two checks on the destination root, and the reasoning recorded alongside them is that nothing satisfying both can climb back out to the committed folder. That reasoning is about the finished path, but it had only ever examined the root — and the new helper appends a second caller-supplied piece, the chain name, which one script reads from an environment variable. A chain name containing the usual step-up-a-directory notation therefore walked straight back to the committed inventory the redirect exists to protect. The same check now applies to both pieces, and it is one shared check rather than a copy per site, since a copy is how the two halves of a single rule drift apart.

Worth recording because the comment was load-bearing and wrong: the note on the existing path helper stated that every artifact path in the library was built there. It was not, in two separate ways, and it had been read as assurance. It now says where the single place actually is and names what had been sitting outside it.

Closes #2261.
<!-- assembled-fragment: 2261-artifact-path-rooting.md sha256=9ed25ce27c4e2f02feebdeb170323cd55393020c254542e619ffa3820ccdf43b -->

## Thread — the writers are held while the off-chain database is moved (PR #2280)

The platform's off-chain database is being moved to its successor. For the
length of that move the three services that write to it — the indexer, the
keeper and the agent — are deployed with **no way to reach any database at
all**.

That is the point, and it is not a precaution layered on top of one. Nothing
available to the platform can revoke a handle that already-running work holds,
so the only thing that genuinely stops new writes is deploying services that
cannot name a database. Watching a database hold still is evidence; removing
the means to write to it is closer to proof, and the difference is what this
step buys.

**What a user sees during the window.** Indexed activity stops advancing, so
recently confirmed on-chain actions take longer than usual to appear; alerts
and notifications pause. Nothing is lost — the chain is the record, and the
services resume reading from it when the move completes. No funds are moved,
touched, or at risk at any point: this is a move of off-chain bookkeeping
between two databases, and the database being left behind is **retained** in
full afterwards, so nothing depends on the move having been perfect.

**What happens next.** Once the services are confirmed to be serving with no
database access, the old database is read twice ten minutes apart to confirm it
has stopped changing, its rows are copied to the new one, and the services are
redeployed against the new database. Afterwards the old one keeps being
compared against the new one — weekly, for as long as it is kept — because work
suspended across the window can still commit afterwards, and retaining the old
database makes such a record recoverable while only continuing to compare makes
one found.

If this state is still in place long after it was announced, the move did not
finish; the operator runbook says what to do, and restoring the previous
configuration is explicitly not it.
<!-- assembled-fragment: 2214-cutover-barrier.md sha256=15180683598d1fd3b65ec207077dd62d27c313830a3813ff738aa47f2ce811d8 -->

## Thread — the shared off-chain database moved, and the move was made all at once or not at all (PR #2267)

The platform's three background services and its nightly backup all read one
shared database. That database has been replaced with a different one. Nothing
a user can see changes; what changes is which database is behind it.

**Every written reference to the database moves together, and a guard in the
repository is what enforces that.** The database is named in four service
configurations, in forty-three operator commands spread across runbooks and
deploy scripts, and in one script that builds its command rather than spelling
it out. A move that reached the configurations but not the commands would leave
a person applying schema changes to a database nothing reads — and both halves
would look correct on their own. The guard refuses any state where those
disagree.

**That is a guarantee about the written record, not about the running
system**, and the distinction is the whole reason the rest of this note
exists. The services deploy independently, so production necessarily passes
through a state where some have moved and others have not, and a failed build
can leave it there. Nothing in a repository can prevent that. What makes the
live move safe is stopping the writers and then checking every service's
actual binding afterwards — described below — and this note previously
credited the guard with a safety it does not provide.

The guard did earn something concrete here: it refused to let the retired
database be exempted from its own check, which surfaced a rollout instruction
still telling operators to apply migrations to it.

**The new database was four schema changes behind and missing two tables.**
Those were applied through the ordinary migration tool rather than by running
the statements directly, so the record of what has been applied is the tool's
own rather than something hand-written to look right. Both databases now report
the same fifty-three applied changes and the same forty-six tables.

**Then the contents were copied — 1,384 rows across 17 tables — and checked
against the source.** One table was deliberately not copied: the record of which
schema changes have been applied. The new database's own record is correct, and
copying the old one's would have asserted that changes had run there which never
had.

**Counting rows is not checking them, and that distinction earned itself here.**
The first check compared how many rows each table held on both sides, which is
enough to catch rows going missing and nothing else — two tables can hold the
same number of rows and disagree about every one of them. Replacing the count
with a comparison of the actual contents immediately found two tables that the
count had called equal and that were not: the markers recording how far through
the chain the indexing service has read, and a periodic financial snapshot.

Neither was a copying error. Both are tables the live services rewrite
constantly, and the source had simply moved on in the minutes since the copy —
the newer values were on the source, in order, exactly as a running system
produces. But a count could never have told the difference between that and a
copy that had quietly mangled them, which is the reason the content comparison
is now the check and the count is not.

### A data-loss bug in the copy, found by checking rather than by it failing

The first copy reported success and was wrong. One row was missing afterwards,
and the reason is worth recording because the copy had looked obviously correct.

The tool used a write that means *"insert this row, or replace it if it already
exists"*. Replace, in this database engine, is delete-then-insert. One table
holds rows that are automatically deleted when their parent row is deleted —
and the copy worked through tables alphabetically, so it wrote the child rows
first and the parent rows later. Rewriting a parent deleted it for an instant,
and the child row that had just been copied went with it.

The fix was not to reorder the tables. It was to stop deleting: the copy now
updates rows in place, which triggers no cascade, does not depend on the order
tables happen to be named in, and can be run twice safely. The second run
restored the lost row and every table then matched.

The copy reported success both times. What caught it was comparing the number
of rows on each side — which is how the missing row came to light, and is
**not** the check the procedure now requires. Equal counts are exactly what the
two tables described above had while holding different values, so a count can
let a copy pass with the right number of wrong rows. The required check is the
comparison of contents; the count is recorded here because it is how this was
found, not because it is what to do.

**And the copy itself is now a checked-in tool rather than a terminal
session.** The first one was improvised — which tables, which key identifies a
row, how many rows to send at once, and how to check afterwards all existed
only in the operator's head — and it is the improvised copy that lost the row.
Since the move requires running the copy again once the services stop, a step
that cannot be repeated identically is a step that cannot be verified.

The tool carries its lessons as properties rather than as instructions
someone has to remember:

- It updates rows in place instead of replacing them, which is what the lost
  row was about.
- It carries tables **in dependency order** — a record that refers to another
  record goes after the one it refers to, because the database rejects it
  otherwise and would abort the copy rather than degrade it. Alphabetical
  order got this wrong for one real pair of tables.
- It treats a record **deleted** on the original as a difference like any
  other and removes it from the destination. Without that, an expired or
  cancelled record left over from an earlier copy can never be cleared, and
  the two sides can never be made to match at all.
- It has a **separate, read-only** step for examining a database that is
  **live**: it compares and reports, and has no ability to write at all.
  That is what makes the reconciliation described below possible, and the
  inability is the point — see below.
- It compares contents rather than counts, as part of the copy.
- It works in **either direction**, between **two named databases** — the
  platform's shared one and the specific database being moved to or from,
  each identified by more than its name. Two weaker rules came first and
  both are worth remembering: fixing the destination read as safer and
  quietly made the documented way back impossible to perform, and requiring
  only that the shared database be *one* end would have allowed an
  unrelated database to be copied over it — while being described as the
  restriction that prevented exactly that.
- A table it cannot copy safely, because nothing identifies a record
  uniquely, is named and left alone rather than copied in a way that would
  duplicate it next time.

### A previous decision was reversed, and is recorded as reversed

When this move was first planned, the decision was to **not** carry the data
over: fresh contract deployments were expected, which would have made the
existing records describe contracts nobody uses any more.

Those deployments have not happened. The contract addresses the applications
read are unchanged, so the records describe the system that is live right now.
Starting the new database empty today would not have discarded stale data — it
would have discarded current data, including the markers that tell the indexing
service how far through the chain it had read. Without those, it either re-reads
from the beginning or quietly starts from the present and leaves a hole.

If a fresh contract deployment does land later, the data **derived from the
chain** becomes stale exactly as the original decision anticipated, and
clearing that is one statement per table — naming those tables individually.
Not all of it goes: support requests and a user's alert settings describe a
person rather than a deployment, and a new contract address makes neither of
them stale. A blanket clear would take them with it, which is precisely the
instruction found and retired elsewhere in this move. The original reasoning was sound for the situation it was
written in; what changed is that the situation did not arrive. The planning
document records this as superseded rather than quietly rewritten, so the
earlier judgement stays readable.

### The switch itself has to happen while nothing is writing

The services deploy themselves when this change lands, and they do not all
deploy at the same instant. Anything a service writes to the old database after
the final copy, but before that particular service picks up the new one, would
exist only in the database being left behind — and a failed build could stretch
that gap indefinitely. Copying "just before" the switch does not close it,
because the gap is on the far side of the copy.

Measurement settled this rather than argument: in the twelve minutes between the
copy and the check, the source had already moved sixteen of its chain-position
markers. The window is not theoretical.

So the switch is performed with the writers stopped. The services are first put
into the state where they cannot reach any database at all — the same mechanism
built for exactly this, which makes them decline requests and skip scheduled
work rather than half-finishing it. Callers see a short refusal that says
plainly that nothing they sent was recorded, which is the intended behaviour and
is why that mechanism exists.

**Being put into that state is not the same as having stopped**, and the
procedure no longer treats it as though it were. Depriving a service of its
database prevents anything new from starting, but work already under way still
holds what it was given and can finish writing afterwards. How long that takes
has never been measured here, and guessing a waiting time would be the same
kind of unearned confidence this whole move keeps running into.

So instead of waiting for a duration, the procedure waits for stillness it can
see: the old database's contents are read, read again ten minutes later, and
the copy proceeds only if the two readings are identical — then read a third
time afterwards, to catch anything that committed while the copy ran. This
rests on "a write changes what the database holds", which is true by
construction.

**Watching it hold still narrows the window. It does not prove the work has
finished, and the procedure no longer pretends otherwise.** Work that is
suspended waiting on something else can sit out every reading and commit
afterwards. So the last step is not the switch: once the services are running
against the new database, the old one is read again and anything that turned up
late is **reported** — the step reads both databases and writes to neither, so
nothing the services have written since can be disturbed by it. Each
difference it names is settled by a person. That repeats until two consecutive
runs come back clean — and then **keeps repeating, weekly, for as long as the
old database is kept**.

**Three of the situations it can report have no settlement that makes the next
run clean, and the procedure says so rather than leaving an operator to
discover it.** Two are resolved by changing the data — apply the value the old
database holds, or insert the row it has and the new one lacks — and the next
run stops reporting them. Three are resolved instead by *judgement to leave
things as they are*: a key already allocated on both sides, a row deliberately
left deleted on one side or the other. The data is unchanged by design, so the
comparison reports them again, and again. A run carrying only those, each
logged with the decision taken, counts as clean; a rule that demanded silence
would be one an operator could satisfy only by giving up on the check. Letting
the comparison record a decision and honour it is tracked separately, as
#2279.

Two clean comparisons are two readings. Nothing available to the platform can
withdraw the access that already-running work holds on the old database, and
how long such work can run has never been measured, so a record can still
arrive after both. Keeping the old database makes such a record
*recoverable*; only continuing to compare makes one *found*. So the runbook
gives the comparison a cadence and a duty — weekly, by whoever holds the
cutover runbook, from the switch until the old database is deleted — and every
run is written down, clean ones included, because the value of that record is
that a gap in it is visible.

**What the runbook does not give it is a name.** "Whoever holds the runbook"
is a duty attached to possession, not a person, a team or a rotation, so there
is nobody the missed week is missed *by*.

What that costs is time rather than safety, and the difference is worth being
exact about. The retirement checklist demands this comparison be current, and
every run is written down so that a gap in the record is visible — so an honest
pass over that checklist stops at a lapsed cadence instead of deleting through
one. What an unowned cadence does cost is that a late write stays undiscovered
for as long as the lapse runs, and the old database is retained indefinitely
behind a check nobody is tasked with keeping green. Naming an accountable party
is an owner decision and is tracked as #2287.

**The comparison holds up once the two databases stop being the same shape.**
The new database keeps taking migrations; the old one never will. So a column
the new one has dropped is compared as *absent* rather than as empty — the two
are different facts, and reading absence as emptiness would let a late write of
an empty value read as the two sides agreeing. The uniqueness rules consulted
are the new database's, because it is the one that would reject the record an
operator adds on the strength of a report; one the old database cannot be
measured against is named in the output rather than passed over. And a
comparison run no longer stops at its list of differences: two of its checks
look for late writes that leave no visible difference at all, and they come
afterwards. A table that exists only on the new database — what a migration
creating one looks like from the old one's side — is shown as drift rather than
failing the run, since it cannot hold a late write from the old database and
failing on it would end the weekly check at the first schema change. A table
the new database has DROPPED is no longer refused either: the old one still
holds it, and comparing it against the record of what was copied still answers
the only question that matters — whether anything was written there after the
copy. It is reported once, with counts, since there is nowhere left to apply it.

**The weekly comparison reads the live database as a live database.** The check
that makes the one-off copy trustworthy is a demand that what is being read has
stopped changing — right for a database nothing is writing to, impossible for
the one serving users, and a busy table would have aborted the weekly
comparison telling the operator to stop writers the procedure never asks them to
stop. It now reads in primary-key order instead, which is what makes dropping
that demand safe rather than merely convenient: every record present for the
whole read is returned exactly once, where the previous method lost one whenever
an earlier record was deleted mid-read. A record created or deleted *during* the
read may or may not appear, which is a fact about the question rather than an
error.

**And the rollback now compares before it migrates.** Returning to the old
database means bringing its schema up to date first, and a migration can delete
rows. The procedure used to say a comparison was unavailable at that point,
which stopped being true earlier in this same change: it runs, and before the
migration every late record is still there to be named. Afterwards some are
gone — and a column-removing migration also puts the record of what was copied
out of reach, so the very check that would have reported the loss is degraded
by the change causing it.

**Four kinds of difference will keep being reported no matter what the
operator does about them, and the runbook now says so rather than leaving
someone to discover it.** The comparison reports differences in data; some
differences are resolved by a decision that changes no data — a deletion that
should stand, a clash resolved by keeping both records under separate
identifiers, a stale copy the operator decides to keep — and the next
comparison therefore finds the same difference again. The fourth is not a
record at all but an identifier: one the old database allocated and released
after the copy, which leaves nothing to apply. The new database reaching the
same number is no longer read as an answer, since it allocates identifiers for
its own records constantly and by number the two are indistinguishable. Those are recorded once
with the decision taken and the weekly comparison continues, since its job is
to surface what is new. Making a decided difference stop reporting means
recording decisions somewhere, which is a change to the one tool whose entire
safety property is that it cannot write; that is tracked separately rather
than improvised here.

**A late arrival and a late change are different problems, and only one of
them is obvious.** A straggler that creates a new record leaves the new
database without it, which the reconciliation can see and name. A
straggler that *changes an existing* record — an offer's status, a
notification preference, how far the chain has been read — leaves a record
that already exists on both sides, so a reconciliation that asks only "is
this record present?" has nothing to say about it at all, reports that it
found nothing, and calls itself finished while the new database is stale. That is counting
instead of comparing, one level up from where the same mistake was caught
earlier in this move.

Comparing the two databases against each other does not solve it either: by
then the new one has legitimately moved on, so almost every active record
differs. What identifies a straggler is that the record changed **on the old
database, after the copy** — a question about that database and its own
past. So the copy now writes down what it saw, and the reconciliation
compares against that record.

**Having that written record turns a two-way question into a three-way one,
and the difference is not academic.** For any record there are three facts:
was it in the copy, is it on the old database now, is it on the new one now.
Those three answers are what let each divergence be *named* correctly — and
naming it is the whole job, because the step writes to neither database and
a person applies every difference it reports, including the simplest one (a
record that appeared on the old database after the copy and has never
existed on the new one). Three of those divergences were being got wrong in
ways that all *looked* like success:

- Both databases can allocate the **same new identifier** for different
  records once they are running independently, since some records are
  numbered sequentially. Carrying blindly would drop one of the two.
- A record the new database has since **deleted** — a closed support
  request, an expired link, a pruned diagnostic — is absent there, which is
  indistinguishable from never having arrived unless you know the copy
  carried it. Re-adding it would silently undo a deletion, and some
  deletions are privacy obligations rather than housekeeping.
- A record **deleted on the old database** after the copy is not in its
  records at all, so anything that works through them never encounters it,
  and the new database quietly keeps a record that should be gone.

Anything found in any of these cases is **reported and left alone**: which
version is correct is a decision for a person, and choosing silently would be
the same overwrite — or the same resurrection — the reconciliation exists to
avoid.

Two further distinctions turned out to matter, and both are about what
"already there" means. A record the **previous attempt already carried** looks
identical to two records sharing an identifier — present on both sides,
absent from the copy's record — so the two are told apart by comparing the
records themselves. Without that, the instruction to repeat until nothing is
found could never be satisfied: the second attempt would object to the first
attempt's own work. And a record can be absent under its identifier while the
destination already holds it under a **different** one, where the same logical
record reached both sides independently; carrying it would fail outright on a
uniqueness rule the destination enforces, so that is recognised and reported
rather than attempted.

### Three smaller things, each about what a report should and shouldn't do

**A run that cannot do everything asked of it now does nothing.** The
procedure promised that a run finding a conflict would change nothing, and
the implementation carried the safe records first and failed afterwards —
leaving a live database partly changed by a command that reported failure.
That is the hardest state to reason about later, because the operator cannot
tell which of the records in front of them that run put there. Everything is
now planned before anything is applied, which turns the promise into a
property.

**A conflict report names the record, not its contents.** It used to print the
beginning of the record, and for support requests that is the user's message
and their email address, sitting immediately after the identifier; for
diagnostic records it is whatever a captured error carried. These reports are
read in terminals, pasted into logs and attached to issues. Someone who needs
to see a value now asks for it deliberately — a decision that leaves a record
of itself.

Two smaller gaps are stated rather than glossed: a write that stores the value
already stored changes nothing observable — harmless for a copy, because the
destination already has that value — and the reconciliation reports what it
found rather than claiming the two sides are identical.

### The step that runs against the live database no longer writes to it

The reconciliation after the switch used to add the records it found
missing. Review kept finding that unsafe from new directions — most
recently that another record can claim a uniqueness the platform enforces
in the moment between checking and writing, which no amount of checking
first can prevent, because a check against a database other things are
writing to describes the instant it ran and holds nothing still.

So the ability to write was removed rather than guarded. The step now reads
both databases and **reports every difference**, including the one case it
used to apply on its own — a record the old database gained that the new one
lacks. A person applies those, deliberately. Since the expected number is
zero, and any that appear are records written in the seconds after a
service was told to stop, that trade buys a human decision on every record
that moves after the switch and gives up an automation nobody should want
racing a live database.

### Checking that two databases have the same shape, without listing what shape means

Before records are copied, the two sides must agree on how a table is
defined. Two attempts at that compared a list of features — first the
column names, then the columns plus the uniqueness rules plus part of the
relationship information — and each time review named something else that
can differ while all of those match: the types, whether a column may be
empty, its default, the rules a record must satisfy to be stored at all,
and the automatic behaviour attached to the table.

Listing the features of a schema is the same kind of unbounded list as
listing the ways code can reach a database, and it fails the same way: the
list reads complete and is not. So the comparison is now over the
definition the database itself stores for the table and each of its
indexes. Anything the two sides declare differently shows up, including
things nobody thought to look for.

### A failed copy must not rewrite the record of what was copied

The copy writes down what it carried, and the later reconciliation reads
that record to tell a late change apart from the destination's own
progress. A copy that **stopped** — because it found something it would
not resolve on its own — used to write that record anyway, describing
values it had just declined to carry.

The consequence is quiet and bad: the reconciliation would compare the old
database against that record, find them the same, and conclude that any
difference must be the new database moving on by itself. A record changed
late on the old side would be classified as someone else's progress and
skipped — in the exact step that exists to catch it. Now only a copy that
succeeded writes the record, and a copy that stops leaves the last true
one in place.

### Nothing here reports success by staying quiet

Three separate places were doing it, and all three now fail instead.

A table the copy could not handle — missing on the far side, with nothing
identifying its records uniquely, or shaped differently on the two sides — was
printed as skipped and then followed by a success message and a success exit
code. Anyone, or anything, reading that result would have carried the move
forward having silently omitted an entire table.

The check that confirms where a service ended up treated "attached to no
database at all" as acceptable. That is the deliberate held-off state *during*
the move and a failed deployment *after* it, and the check is what authorises
going back to normal operation — so it now refuses unless the operator says
explicitly that they are still inside the window.

And the copying tool's safe mode had to be asked for by exact spelling, while
anything it did not recognise was ignored. A mistyped request for the safe
mode therefore ran the destructive one — against a live database, deleting
records only it held. The mode must now be stated, and an unrecognised
argument is an error rather than a shrug.

### The check that the move happened was itself reading the wrong thing

The last step of the move is confirming which database each service ended up
attached to. The instruction for doing that said to read the service's stored
configuration — and that turns out to report the most recently *uploaded*
configuration, which on this repository is routinely one built from a branch
and released to nobody.

This was not a theoretical objection. Read that way during the preparation,
the indexing service reported the **new** database while the version actually
handling requests — released the day before — was still attached to the
**old** one. The move would have been declared complete while every write
continued to land in the database being left behind: a check that fails in
the direction of saying yes.

The check is now a recorded procedure that asks what is *serving*: the
release currently taking traffic, every version within it — traffic can be
split across several, and a move that reached most of it is not a move — and
that version's own attachment. Run before the switch, it correctly reports all
four services still on the old database, which is what a working check looks
like when the thing it checks has not happened yet.

### Rolling back is another move, not an undo

The old database still exists and still holds its rows. Nothing here deletes it,
and it remains where a rollback goes. But **rolling back is not simply pointing
the configuration back**: once the services have written to the new database,
those rows — support requests, alert thresholds, signed offers, notification
state, chain positions — exist only there. Reversing the configuration without
carrying them across would strand them exactly the way going forwards without a
copy would.

A rollback is therefore performed the same way as the move: stop the writers,
carry the rows, switch. An earlier version of this note said the move was
reversible "with no data to recover because none was destroyed". Nothing is
destroyed, which is true and is not the same claim — the data is not lost, it is
in the wrong database, and getting it back is work rather than a config edit.

Retiring the old database is a separate, later decision, to be taken when
somebody is confident it is no longer needed.

Closes #2214.

### The procedure's own first step could not be carried out

The move pauses the three services by publishing them with no database
attached — that is what makes the copy safe, and everything after it depends
on that pause being real. Publishing them is done by merging the change:
these services have no other route to production.

The consistency check added by this same change refused that state. It
required one nominated service to name the database and compared everything
else against it, so removing the attachments removed the thing it compared
against, and it reported there was nothing to check. The pause step was
therefore unmergeable, which made it unperformable, which made the whole
procedure undeliverable — found by trying it rather than by reading it.

The rule it was really there to enforce never needed a nominated service:
**everything that names the shared database names the same one.** That holds
with no nomination, and it states the failure it exists to catch — two
services naming different databases — directly rather than as a comparison
against a privileged file. The three services are additionally all-attached
or all-detached, because one left attached while the others are paused keeps
writing through a window every later step treats as closed.

### The copying tool read its own endpoint from the thing the pause removes

One end of the move was read from a service's configuration — the reasoning
being that the shared database is written down once and everything should
agree with it. That is the wrong source for this tool, and the pause is
where it shows: pausing the services removes exactly that entry, so during
the only window in which the copy ever runs, the tool could not tell which
databases it was between and stopped before doing anything.

A service's configuration says what that service is attached to right now,
which across a move is the thing in motion. The two ends of the move are
not in motion — they are what the move is between — so both are now written
in the tool itself. Drift between the tool and the live configuration is
still caught, by the consistency check, which is where that question
belongs.

The same check was also accepting a pause that had not happened: it looked
for the absence of one named attachment, so a service that kept a complete
attachment under a different name was counted as paused. It now requires
the attachments to be genuinely absent — a handle under another name is
still a handle.

### A name is a label; an identity is not — and only one tool knew it

Both ends of the copy are named in advance and each is identified by more
than its name, because a name can be reissued to a different database after
a deletion. The check that confirms which database each service is actually
attached to did not follow that rule: given a name, it asked the account
which database currently owns it and trusted the answer.

That matters in one direction in particular. Going back means confirming the
services are attached to the database being returned to — and if that
database had been deleted and recreated under the same name, every service
attached to the replacement would have passed the confirmation while the
retained records sat somewhere nothing was pointing at. The check would have
reported the return complete, and the data it exists to protect would have
been the part left behind.

The pair is now written down once and read by every tool that needs it,
rather than by each separately, so the rule cannot hold in one tool and not
another. A name that is neither of the two is refused outright, and the
refusal says why rather than falling back to a lookup.

### Two tools kept separate lists of the same services

The check that confirms each service is attached to the right database, and
the check that keeps every written reference in agreement, each carried
their own hand-written list of which services touch the shared database.
Nothing made the two lists grow together. Adding a fourth service and
registering it in one list but not the other would have left the pause
confirmation reporting success having never asked about it — while it wrote
straight through the window the pause exists to create.

There is now one list, read by both, and it is self-checking: any service
configuration in the repository that declares an attachment to a database
and is not classified in it — as a consumer of the shared database, as one
the pause must hold, or as one that must not share it at all — is refused by
name. The list still has to be written, because a service whose attachment
is removed for the pause declares nothing and cannot be discovered; what the
check removes is the case where the repository knows about a service and the
tools do not.

The identity rule also reached the last place that only had half of it: the
check that keeps references in agreement compared the pinned database's name
and not its identity, so a pinned identity edited to any other valid one
passed while naming the right database — and the copying tool uses that
identity directly as its destination.

### The move does not end by deleting the database it moved away from

The procedure's final checklist read as authorisation to delete the old
database once its boxes were ticked — two clean comparisons among them.
Elsewhere the same procedure states that work suspended on something
outside the platform can sit out every reading, and that how long that can
take has never been measured. Both statements were in the same document,
and the one attached to the irreversible step was the optimistic one.

Two clean comparisons are two readings. They say nothing arrived by the
moment each one looked. A straggler can commit after both, and because a
change to an existing record leaves the record count identical, the count
re-check would not notice.

So the old database is now **retained** at the end of the move. Deleting it
is a separate decision for a person, and what would make it safe is named
rather than implied: a measured limit on how long already-running work can
still write, or a way to make the old database refuse writes outright,
neither of which exists — or a deliberate acceptance that a late record is
lost, weighed against what those tables hold. They are support requests,
alert settings carrying contact identifiers, signed offers. The cost of
keeping the database is one unused database.

### A step that would have deleted user data

The same reversal left a live instruction to empty the new database before
the move — including a user's alert configuration and four open support
requests. It belonged to the abandoned plan where the new database was to
start empty, and nothing later in the procedure put those records back. It
is retired in place rather than removed, because it was the documented
first action for seven weeks. Nothing replaces it: the copy makes the new
database match the old one record by record, which is what emptying it was
for.

### The way back destroys the copy it is supposed to protect

The old database is kept so that anything written to it late stays
recoverable. Going back, as written, would have rewritten it — applying
schema changes to it in place and then overwriting its contents from the
new database — each step justified by a check performed a moment earlier.

Those checks cannot justify it. Nothing in the procedure can take away
access that a piece of work already has to the old database, and the
platform has never measured how long such work can run. So a check is a
statement about the instant it ran, and a step that destroys records on the
strength of one is unsound — three separate steps did exactly that.

The honest version is stated rather than patched: going back must never
write to the old database at all. It should build a new one, seed it from
the live database, apply the records the old one holds and the live one
does not, and point the services there — leaving the old database
untouched, which is what keeping it was for. That is a larger change than
this one and is recorded separately.

Until it exists, the procedure says plainly that two of its steps destroy
records in the old database and that no check in the document makes them
safe. That is worse than what it implied before, which is the reason for
saying it.
<!-- assembled-fragment: 2214-d1-cutover-archive-to-warm.md sha256=70ff3aa9d333fa60f47f0c32a27a91abf0d523e8fe50ebba48e7ac21c4c9003a -->
