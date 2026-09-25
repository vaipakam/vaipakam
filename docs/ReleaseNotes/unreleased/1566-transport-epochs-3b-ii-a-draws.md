### Reward transport epochs — the draws (#1566 PR 3b-ii-A)

The previous transport-epochs release gave every old-wire reward delivery
its own **epoch**: one untyped balance, bound to the days the delivery
named, that nothing could yet spend. This release lets the obligations on
those days spend it.

When a claim, a forfeit or an expiry settles an armed day that an epoch
lists, the day is now paid from that epoch **first** — ahead of the live
delivered ledger and ahead of the recycle bucket — and only the residual
reaches the shared sources. This is the order the design requires: a
claim whose matching transport sits parked must not draw down the funding
every other claim shares. The rule is applied in exactly one place, the
day pricing every one of those settlements already goes through, so the
claim, the forfeit sweep, the expiry sweep and the preview the claimant
sees cannot disagree about what an epoch pays. The preview says what the
claim will do; the executable-now predicate that drives the expiry clock
reads the same figure. That predicate's recycled test now reads the claim
walk's own draw on the recycle bucket — net of what the epochs pay, the
day the walk would refuse included — where it previously compared a
pre-cap upper bound. The bound could not be netted by an exact epoch
figure: on a day the per-user cap trims, the difference left a residue no
claim would ever draw, and an obligation an epoch covered in full read as
a bucket drought without end, its expiry clock never starting. The walk's
figure carries what the bound was kept for — it is the joint draw of the
claimant's whole day set, and it is measured day by day — without the
slack. A settlement the walk would refuse because more epochs list a day
than one read scans is likewise not executable until the day's cursor has
been pruned, which anyone may do.

An epoch's balance is untyped, so when it cannot cover both of a day's
legs it is split in two steps. First the day's own shortfalls — each leg's
need net of the source that already covers it (the delivered ledger for
fresh, the bucket for recycled) — because a day cannot settle otherwise.
Then whatever coverage remains goes to whichever leg carries the greater
deficit against the shared sources over the **allocation domain**, fresh
first on ties. The domain is the days one settlement call prices for one
claimant — a single day for a forfeit or expiry sweep — and its needs are
totalled once per call and worked down as days settle; nothing is carried
across calls. The domain is deliberately the GROSS needs — what the call
would price if every day settled — not the days a funded call ends up
settling: those depend on which leg each epoch's leftover coverage took,
which is the very choice the domain guides, so a funded domain would be a
fixed point with no single-pass answer. The choice only decides which shared
source pays an obligation in the call — never whether value is paid, moved or
lost — and a day it leaves short defers whole to the next call. Since an
epoch is drawn only once attested, and an attested epoch's two component
rooms together never exceed its balance, the choice has nothing to decide for
any epoch ingress creates today; it is kept for an epoch whose rooms together
exceed what it holds. The same pass's quick check for whether any reachable
day lists an epoch now gives each side the whole day allowance, since a side
that defers on its first day leaves the next side all of it. Two of the
design's own cases are the reason. Five fresh and
five recycled, with five of live fresh, an empty bucket and a five-token
epoch, is fully payable only if live pays the fresh and the epoch pays the
recycled — a blind fresh-first rule would refuse a claim the funding fully
covers. And one claimant over two days, each needing fresh and recycled,
with live covering both days' fresh, the bucket only one day's recycled,
and an epoch worth one day's recycled listing the first day, settles both
days only if the epoch pays that day's recycled: a rule that looked at
the first day alone would spend the epoch on fresh, drain the bucket, and
leave the second day waiting. What crosses a call — a long obligation's
later days, or other claimants' demand on the same shared sources — is
the overlapping-membership matching the contested-allocation machinery is
for, and this release states that rather than pretending to a scan it
cannot afford.

What each ledger sees afterwards follows from the source. The 69M emission
cap and the delivery's commitment retire by the full figure — an
epoch-funded payout is still emission, and the obligation ended. The
delivered ledger and the bucket are charged only for what they actually
paid. The epoch-paid share leaves the custody row where an epoch's value
rests and goes to the claimant directly, or, for a forfeit or an expiry,
recycles in place, because there is no claimant to transfer to. An
epoch-funded forfeit or expiry therefore settles even while the live
backing row is empty, which on a mirror funded only by the older wire is
the ordinary case; a live-funded one is bounded by that backing exactly as
before, and a shortfall of it still defers.

Every draw is recorded on the epoch as a fresh leg and a recycled leg, so
the ledger's conservation identity — what was admitted equals what is
held, plus what was parked, plus what left by classification, plus what
the legs paid — holds after every draw, and a delivery's attested fresh cap
is netted by the fresh leg its epoch has already paid.

**An epoch is drawn only once its split is attested.** Until the source
chain's attestation of a delivery's fresh/recycled split lands, its epoch is
withheld from every day's draws and reported as withheld for that reason.
A leg is typed once, by the caps it is drawn under, and never retyped. An
earlier version drew an unattested epoch and retyped its legs when the split
arrived — but by then the claim had already charged the bucket, released the
recycled commitment and charged live funding for the legs as first typed, so
the retyped epoch and those ledgers told different stories. Once attested, the
epoch pays each leg only within that component's remaining cap, each cap read
net of the classification the delivery already carried; a classification
recorded before the split that already exceeds a cap is not undone by the
attestation — it is recorded as a divergence for the correction path, and no
further draw or classification of that component is admitted meanwhile. A
later classification correction moves no drawn leg either: where it takes a
component's classification plus that component's drawn leg past the cap, the
excess is reported on the same divergence view and no further draw of that
component is admitted. A deferred settlement's cursor move is progress the
claim keeps even when it paid nothing, so a retry never scans the same
exhausted window twice, and such a deferral ends that call's settlement on
every side, so the preview — which cannot move the cursor — describes what
the claim did, and the preview simulates the cursor advance a side's
draw performs — exactly where the claim's settlement would reach that
draw, and nowhere else — so its later sides read what the claim's would. A day's reported coverage counts only what its epochs can
pay through at least one leg, and an epoch whose attested split leaves no
room under either cap is passed by the day's cursor as exhausted even
though a residual unit remains, so it cannot hold a window slot forever.
The residual leg of an epoch's coverage is chosen
on each leg's deficit net of what the day's own shortfalls already drew.

A day's index is kept in **arrival order** whoever indexes it — an epoch
indexed late takes its place by arrival, or, when that place is among the
epochs the day's cursor has already passed, its place by arrival among the
epochs after the cursor, so it is never behind the cursor, the cursor never
moves back (which is what lets the day report its consumption as an exact
count in constant work), and which late epochs a window holds is the
ledger's choice and not the indexer's; same-block arrivals in a fixed order by delivery identity, and each epoch
linked into its place in constant work (a materializer may name the
predecessor; without one the ledger searches back from the newest for a
bounded number of steps and refuses beyond that), so indexing an epoch
late never costs more than indexing it on time; every epoch is linked as
it is indexed, so a day's order holds it whole from its first member and
a day is read one way only — an earlier revision of this release carried a
second, membership-ordered read path for days indexed before the order
existed, with a catch-up step and a switch-over; no chain ever held such a
day, and two read sources were the root of several review findings, so the
path was removed rather than carried —
so the **bounded window** a day is read through always holds its oldest
epochs, and within the window they are spent in an order the ledger
fixes rather than the order anyone indexed them: the epoch listing the
**fewest days first**, the oldest arrival on ties; the order is a
property of the epochs in the window, never of who indexed them or how
they were read, and that order is the priority in which epochs are spent.
An epoch's flexible balance — what either leg may take — is held back
from a leg only where a later epoch's capacity for the other leg could
not otherwise be used, so the two legs are paid the most any assignment
could pay them without a lower-priority epoch being spent ahead of a
higher one. Where either leg could take a flexible unit and the day is
covered the same amount either way, it goes to the leg that would otherwise
have to **reach furthest** into the window to be served, so the epochs
actually opened are the earliest ones and the furthest — which may be the
only one funding another day — is left standing. A leg the window cannot
serve at all reaches past its end, the furthest there is, so it is served
at once, which is the same rule as the reservation above. Coverage one leg's cap rejects
is offered to the other leg; a day wider than one window is read through
that window and draws from it, rather than being refused outright, because
the window is always a prefix of the day's one order; an attested
epoch pays each leg only within that component's recorded cap, and the
one unit a scaling residual can leave outside both caps is never drawn
once the split is known — drawn before it was, it is recorded beyond
both caps, inside the epoch's identity, for the close-out's disposition
path; and a
forfeit's or an expiry's recycled slice is a commitment release, not a
funding pull, so it draws no epoch value — the epoch's coverage goes to
the legs that need funding. An epoch that lists fewer days has fewer other
obligations that could need it, so it is spent first and the wider one is
kept for the days only it can fund — the design's own default, applied on
chain because indexing is open to anyone and its order would otherwise
decide who gets scarce funding. An epoch whose membership is still being
written in pages is invisible to every day until its last page lands, so
a first page's days cannot drain what later pages' days were owed. When
more epochs list a day than one window scans, and the visible coverage
cannot cover the day while a residual would otherwise fall through to the
shared sources, the day is deferred rather than paid short: nothing is
drawn and nothing is staged, so there is nothing to unwind, and the day's
cursor is moved past any epochs already exhausted by other days so the
next attempt sees a fresh window. Anyone may run that cursor maintenance
for a day at any time. A transaction draws from at most one hundred and twenty-eight epochs over every day it settles — the bound is the transaction's gas, so two settlements batched in one transaction share it; a day whose draw would take the transaction past that is deferred exactly as a day whose epochs exceed one window is — nothing drawn, the days before it standing, and a settlement batched after one that spent the budget pays nothing rather than failing the batch — and the next transaction starts there, so a claimant funded by many small epochs progresses a few days per transaction rather than never. The follow-up release adds the staging that lets a
day wider than one window make progress; until then such a day waits,
with its value protected in its epochs. A day no epoch lists costs one
storage read and no call, on every chain, and the domain rule's own pass
first reads, without pricing anything, whether any day the call could
price has an epoch listed — the same reads the pricing makes — so both
are decided from the ledger itself: the draws and the split are right
from the first block of an in-place upgrade over a ledger that already
holds epochs, with nothing to count and nothing to migrate. Every draw is
also recorded on the delivery's own packet as an exit, so the packet's
identity — what it put in equals its untyped remainder plus every exit —
holds after each draw as the epoch's conservation identity does. The
claimant's armed-need reading keeps its shape; it counts the epoch-paid
fresh in the requirement it reports and says, beside it, how much of that
the live delivery must fund.

The preview a claimant sees simulates the draws it predicts, on either
side of the claim: within one
preview, an epoch listing two days is not counted for both, so the figure
shown is the figure the claim pays. And a claim's recycled leg that an
epoch paid retires its commitment the way a forfeit's does — without a
bucket debit, since the bucket never paid it — so what the mirror reports
as fundable is not depressed by obligations that have already ended.

**An epoch listing more than one day is withheld until contested
allocation lands.** The design refuses a draw that another day's known unmet
obligation is competing for, and draws an epoch listing a not-yet-arrived day
only for a day's gap. Neither condition can be checked yet: an epoch records
how many days it lists but not which ones, and there is no per-day record of
unmet obligations. So every epoch listing more than one day is withheld from
every day's draws, reported as withheld for that reason, and kept whole for
the contested-allocation machinery, which settles it. An intermediate version
of this change drew such epochs last, for a day's gap only; that still let an
underfunded day drain an epoch another day's unmet obligation was counting
on, which is exactly the contested draw the design refuses. A day that only a
shared epoch could fund defers until then; nothing is spent or lost.

**A claim now allocates against the live funding it will actually be
checked against.** The claim chose which part of a day an epoch pays using
the delivered ledger alone, while its final check requires every live-paid
unit to be backed by tokens actually held. With the ledger showing funding
the backing could not support, the allocator could spend an epoch on the
recycled leg and leave the fresh leg to live funding that the final check
then refused, reverting a claim that a different split funds in full. The
claim and its preview now read the same live-backed figure the expiry and
forfeit sweeps already used.

**The reconciliation view says when an excess is not yet knowable.** For a
recorded delivery whose split has not arrived, the view that reports how far
a classification exceeds its attested caps now says so explicitly instead of
reporting a zero, which reconciliation tooling would have read as "within
its caps".

What this release deliberately does not decide: the close-out of an epoch
(parking its remainder, acknowledging it, the operator dispositions) stays
unavailable to everyone, as the previous release left it, until the per-day
obligation check that gates it lands.
