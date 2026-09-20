# Release Notes — 2026-09-15

Four entries. The first is the second half of the #1566 closure-2 cutover
apparatus — the legacy reconciliation epoch — and it is the one that
moves attribution: an administrator, under the platform's manual pause on
an activated deployment, classifies the value the first half protected at
ingress into fresh or recycled backing, corrects a classification —
unspent value moving with its tokens, spent value moving as a debit the
other side inherits, and only what the side's own ledger charged — and
reconciles the inventory that predates packet stamping once, as one
aggregate the platform measures itself. What makes
those moves safe to offer is stated with them: a fresh share needs
evidence the administrator cannot write, which no transport supplies yet,
so until the transport epochs land a classification can only be recycled
(the envelope's administrator-funded fresh is the one fresh the epoch can
carry, and its later correction is bounded by it); what each outflow
spent of a classified value is recorded into the entry's own record — in
bounded work at the outflow, the remainder carried and written by later
steps anyone may take, and a correction waits for it — so a correction
never infers spent-ness from a total and never inherits a payout that
did not happen; and the identity that ties the recycled backing's lifetime
figures together has one implementation on chain, which the one-time
stranded backfill and the mesh watcher both read. The remaining three
entries are threads on the loan-status reconciliation that the previous
day's release opened: a correction that could close a position on a block
the chain never called settled now refuses a guessed block and says so;
two published figures that named the wrong ingest arrangement now receive
the answer already decided; and a check that failed late and reported
nothing it had noticed now reports once, after either ending.

## #1566 closure 2 — the cutover apparatus, part two: the legacy reconciliation epoch (PR #2206)

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
correction is bounded by it), or written down. The resolution must be exact. What the import credits — the
relocated and replaced recycled share, the funded fresh — is entered into
the same correctable record as every classification, so a wrong fresh or
recycled attribution of the credited portion has the same correction; the
write-down and the choice between relocating and funding are recorded
once and are not correctable afterwards, so the import must be right the
first time. The epoch has no end: nothing here
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
<!-- assembled-fragment: 1566-closure-2-cutover-2.md sha256=9404704456d185ec08452a0a75dc3cf3eb65067e19df53f3329f209f625ed177 -->

## Thread — A correction could close a position on a block the chain never called settled (PR #2211, issue #2201)

Before the platform corrects a loan's recorded state against the chain, it
has to pick a moment to look at. It asks the chain for the point the chain
itself treats as beyond revision. Some providers cannot answer that question,
and some that can will occasionally fail to — a timeout is a failure like any
other — so there is a fallback: step back a fixed distance from the newest
block and treat that as good enough.

That fallback is a guess about finality rather than the chain's statement of
it. For the correction it is the wrong kind of answer, and the platform's own
specification says so in as many words: the state a correction relies on must
be read at a point the chain treats as settled, never at a point derived from
what the source last saw.

The cost of being wrong is not symmetric with the rest of the platform's
reading. The correction looks only at positions still recorded as open, so a
position it records as ended leaves the set it draws from and is never looked
at again. A reorganisation deeper than the guessed margin could therefore show
an ending that later vanishes, and the correction — which exists to stop
positions being published as open after they have ended — would publish an
open position as ended, permanently, with no later pass able to find it.

### What changed

The answer to "which block" now travels with where it came from. One piece of
work resolves it, and it reports whether the chain named the block or the
platform guessed it. A reader of that answer cannot take the number without
also being handed that fact.

The correction refuses a guessed one, and **says so**. A chain whose provider
could not supply a settled point has no correction running at all, and the
operator learns that from the log rather than from a divergence months later.
A check that quietly declines to run reports perfect health while records stay
wrong — the same failure a companion change fixed on the same path this week.

The message names a bounded failure category built from what the client
raised — its class, and a numeric code or status where there is one —
never a cause the provider stated; a timeout in particular carries no
provider reason at all. The
fallback is taken whenever the settled read does not answer, so a momentary
timeout on a capable provider looks identical to a provider that cannot answer
at all; telling that operator their setup lacks a feature it has would send
them to fix something that works.

The same resolution also backs the recycling backing snapshot, which had its
own copy of it — the same constant, the same fallback, commented as mirroring
the other. A mirror is a copy that has not drifted yet.

### Two things review found that were worse than the defect being fixed

**A reminder could have been sent about a loan that had already ended.** The
check that compares the platform's records against the chain is followed, on
the same turn, by the one that derives due-date and grace-period reminders
from those records. Those reminders fire once and are never taken back. When
the check refused to run, it reported the same "nothing to correct" as a check
that had run and found everything in order — so the reminders were derived
anyway, from exactly the records nobody had verified. A record left wrongly
open is what this whole area exists to catch, and it is precisely the record
that would have been reminded about.

The two turns now share one answer, which distinguishes *checked, and nothing
was wrong* from *could not check*. Reminders wait for a turn that checked.
This closes a case that predates the change: a turn whose cursor had run ahead
of the chain's settled point already skipped the check and swept anyway.
Waiting costs nothing — a reminder's own window is hours to days — and the
same surface already waits, for the same reason, when the grace schedule it
depends on has not been read.

Nor is "the check ran" the same as "every record was checked". A turn that
finishes normally can still have rows it could not settle — one the chain has
never heard of, one whose state could not be read, one whose correction failed
to write, one in a state this build does not recognise. Each of those is still
recorded open, which is exactly what a missed ending leaves behind, and the
first is the worst of them: the chain has said the loan does not exist and the
platform is still showing it as running. Those records are now held back from
the reminders **individually**, by name. The other loans on that chain are
reminded about as normal — withholding everyone's because one record could not
be read would punish the many for the one, indefinitely if that record stays
unreadable.

That withholding **narrows the window rather than closing it**, and the note
says so rather than implying a guarantee. The check looks at a small number of
records each turn, so a record it could not settle is held back on the turn it
was noticed and not on the turns that look elsewhere. Closing it needs the
platform to remember an unsettled record until a later turn settles it, which
is its own change and is now written down. Nothing here is worse than before —
previously such a record was never held back at all.

And the failure that turn hit is now always said out loud. Saving a place is
bookkeeping, and when a turn checked healthy records and then failed only at
that, there was nothing to report about the records — so nothing was reported
at all, and the failure went with it. A save that keeps failing leaves the
rotation examining the same few records every turn and never reaching the
rest, with every surface reporting health. That is the same silence this whole
thread is about, reached by the narrowest door yet.

**The operator log would have carried the provider's API key.** The message
explaining why no settled point could be read quoted what the provider said,
and providers put the whole request address — key included — inside that text.
On a provider whose settled read keeps failing, that is the credential printed
on every turn. What is reported now is built from bounded fields that cannot
contain a secret, and still tells apart the two cases an operator has to act
on differently.

**A repaired position's notice would have carried no block at all.** Giving
the head a companion fact meant the value passed around was no longer just a
number, and one place that turned it into a number for storage kept accepting
it and quietly produced nothing usable. The notice announcing a corrected
position would have been stored with no position in the chain's order — filed
behind everything, possibly never surfacing, while the correction itself
committed normally. The value is a plain block number again everywhere it is
used that way, and the conversion into storage now refuses anything that is
not one, so the same substitution cannot be made silently again.

### What this does not change, and one thing it does not fix

Nothing about which positions are corrected, or when, on any deployment whose
provider answers the question — which is all of them in the current
configuration. The correction behaves exactly as before there.

**The ordinary scan is exposed to the same guess and is not fixed here.** It
is tempting to say the scan repairs itself — that it can re-read and converge
— and it cannot: its cursor only ever moves forward, so a block removed by a
reorganisation is never read again and what it contained stays missing. The
difference between the two is how bad the wrong record is, not whether it can
be recovered. Deciding what the scan should do when no settled point is
available is a genuine trade against keeping the index moving at all, and it
is left open rather than settled quietly here.

Refs #2201. The published recycling snapshot still does not tell its readers
which kind of block it was pinned to; that is #2210.
<!-- assembled-fragment: 2201-settled-head.md sha256=69355ef6919ac8c717ab6b8f580bc5ee9b3faae6c914feb6aeb2575c98485b6d -->

## Thread — Two published figures named the wrong ingest arrangement (PR #2207, issue #2202)

The platform can take in chain data two ways, and it publishes how fast it
expects to do so — a figure an operator uses to judge how long a wrong record
can survive before the platform notices. Which arrangement is running is
decided by two things together: a switch the operator flips, and whether the
machinery that arrangement needs has actually been provisioned. Both, on
purpose: provisioning the machinery must not silently re-route live work, and
flipping the switch without the machinery must not either.

Three published surfaces were deciding it on the switch alone, because the
switch was the only half they could see. On a deployment where the switch is
on and the machinery is absent — a configuration the platform supports —
those surfaces reported the faster arrangement while the slower one was
actually running.

A wrong figure here is worse than no figure. The whole reason for publishing
it is that somebody sizes a judgement on it, and the surface that would have
contradicted it is not one they were looking at. The intended behaviour was
already written down — the platform states which arrangement is in use rather
than implying a single pace — so this is the code catching up with it rather
than a change of intent.

### What changed

The answer is now worked out once, in the one place that can see both halves,
and passed on already decided. The surfaces receive a yes-or-no rather than a
switch position, so none of them can consult half the question.

That is deliberately not the same as correcting three call sites. Each of the
three was written by somebody looking at what the platform handed them and
using it reasonably; one of them even said in passing that it could only see
the switch, and treated its answer as a floor rather than a fact. The fault
was in what was handed over, so that is what changed — and the next surface to
ask gets the whole answer by default instead of the visible fragment.

### What this does not change

Nothing about how data is actually taken in, and no figure on a correctly
provisioned deployment: where both halves agree, every surface reports exactly
what it reported before. The only deployments whose published figures move are
the ones that were being told something untrue.

Closes #2202.
<!-- assembled-fragment: 2202-ingest-mode-reporting.md sha256=17eb0970314b0336bca737fcd66e1708e58de7d3b0d7a55471912c829799cb26 -->

## Thread — A check that failed late reported nothing it had noticed (PR #2208, issue #2203)

The check that compares the platform's own loan records against the chain is
built to say what it could not establish. A row it could not read, a row for a
loan the chain has never heard of, a state this build does not recognise —
each is named in the operator's log, because a check that quietly skips what
it cannot work out reports perfect health while records stay wrong. Each of
those three exists because somebody found the silent version and said so.

They were being thrown away. The turn saves its place at the end, and if that
last step failed, everything the turn had noticed went with it. So a turn
could examine a record, correctly work out that the chain has no such loan,
fail to save its place, and report none of that — the exact silence the naming
was added to end, reached by a different door.

The worse version of it: saving a place is two steps, and if the first
succeeded and the second did not, the rotation had already moved past that
record. It was examined, not named, and not looked at again until the rotation
came round.

### What changed

There is now one piece of work that turns a turn's findings into what the
operator reads, and it happens ONCE — not at either ending, but after them,
on the single path the two rejoin. The turn works out what it found, whether
it finished or died partway, and only then is any of it said.

Two weaker versions were available and both were rejected. Repeating the
reporting in the failure path would leave the next thing worth reporting
wired into one ending and forgotten in the other — which is precisely how
this went wrong, since the failure path already had everything it needed in
hand and read one field of it. Sharing one piece of work and calling it from
both endings is better, and still leaves "call it" as something an ending can
be written without.

So neither ending reports at all. There is nothing in the failure path to
forget, because there is nothing there to remember — which is a stronger
guarantee than a rule that merely happens to be followed, or one that is
merely tested.

### What this does not change

Nothing about which records are corrected, or when. A turn that finishes
normally reports exactly what it reported before — every case that was already
covered is unchanged — and the failure path now says the same things instead
of almost nothing.

Closes #2203.
<!-- assembled-fragment: 2203-reconcile-diagnostics.md sha256=c8537774b6a6417c21361c03462603f4b62c17e31f9b19de8bfda0493d92b685 -->
