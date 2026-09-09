# Release Notes — 2026-09-09

Two entries from one pull request, both about refusing to conclude more than
the chain can show. The first is a read-only census of the legacy custody the
recycling programme may have to move: across twenty deployments on five
chains it found nothing, and it is exact about which of its findings count as
proof and which do not. The second gives the cross-chain reward role four
states instead of three, because two live deployments sit in the state a
three-state design would have frozen.

## Thread — a census of grandfathered custody, and what it refuses to conclude (#1566)

Part of #1566 exists only to move four kinds of legacy custody out of a shared
balance. Whether that work is large, small, or unnecessary is an empirical
question — it depends entirely on whether any such holdings exist on the chains
already deployed — so this adds a read-only census that answers it, and commits
its output as an artifact rather than a claim. "The set was empty" is something
a later reader must be able to re-run, not take on trust.

The result: across all twenty retained deployments on the five chains —
current contracts and the earlier ones a redeploy left behind, including one
the quick rehearsal deploy had set aside uncounted — the census read 215 loans
and found no holding in any category anywhere it could actually read the
records. Eight deployments are settled on that basis. Twelve are not, and the
census says so rather than rounding them to empty: six because the one
function that would read the intent records is not installed on those
contracts, one because the contract no longer says which token it treats as
VPFI and the record's token cannot be trusted to settle the two categories that
depend on it, three because they are bare shells with no reading function at
all, one because the address on record turns out to hold something that is not
the platform's contract, and one because its record names a contract without
the token that would let its holdings be told apart from other assets — a
record that had until now borrowed its twin's answer. An earlier run had counted eighteen as settled on two
shortcuts since withdrawn; the contracts did not change, the standard of proof
did. The interesting part of this change is that it reports undetermined
instead of zero.

Most of the design here is about the ways a census can produce a comfortable
answer it has not earned. An all-zero result is indistinguishable by inspection
from a scan that read nothing, so each read path was first made to produce a
non-empty answer, and each proof of absence was checked for what it actually
proves. Three of those checks changed the outcome rather than merely
documenting it.

The first: the census reads live state where it can, and where the relevant
view is not present on a chain it consults the chain's own record of routing
changes — a reading that can only rule a record *in* (the producer was
reachable at some point, so records may exist that nothing can read) or
declare itself incomplete; it can never prove the producer was never
reachable, since a public endpoint may omit an addition and its matching
removal with no visible trace. An earlier version treated "the view is
missing" as proof by itself, which is wrong — a component can be added, write
state, and later be removed, leaving records nothing can read. The second: that history scan came back
reporting *no routing changes at all* on two chains, which cannot be true of a
contract that exists, since every one records at least one when it is deployed.
That is now a hard refusal, and it is what turned one chain's result from
"empty" into "undetermined": its recorded deployment block yields no records at
that address, and the public endpoint used discards the history needed to find
the real one. The third: the scan is now pinned to a finalized block and
records that block's identity, not merely its height, and re-checks it
afterwards — a height alone does not identify what was read, and this artifact
is used to certify work away.

Two shortcuts the census briefly took were withdrawn after review, and the
reason is worth stating plainly. A contract holding no VPFI at all was at first
treated as proof that no holdings were recorded — but the design's own opening
reconciliation says the opposite can happen: a reward payout can spend the
tokens that back a recorded holding while the record itself survives, and a
zero balance alongside surviving records is the worst case, not an empty one.
The balance is now reported as *backing*, set against what the records claim,
so any shortfall is visible. Likewise, finding every relevant function absent
from a contract today says nothing about records written before those
functions were removed. Where the census cannot read the records directly, it
now says so.

What remains open is therefore not a history question at all — no amount of
history can prove a record absent, only refute a claim that it is — but a state
one: reading the record's storage directly, with the read first proven correct
against a contract where the ordinary view still works. That, and correcting
the one deployment record that names a contract which is not the platform's,
are the follow-ups.

Two further refinements changed what the census counts and what it will
believe. It now censuses every retained deployment on a chain, not one address
per chain: a fresh redeploy archives the off-chain record but cannot erase
on-chain holdings, so the previous contracts and anything they still hold are
part of the population. And every holding is filtered to the deployment's own
VPFI, since the four categories are specifically about VPFI sharing a balance
with rewards — a snapshot in some other collateral is outside scope and is
recorded as excluded rather than quietly dropped.

Because those archived records are deliberately kept out of version control,
the inventory the census works from is a committed manifest rather than the
local directories; a fresh checkout censuses the same nineteen deployments as
this one. The command that regenerates that manifest may add entries but will
refuse to silently drop any it already lists — on a fresh checkout, where the
local directories are absent, an unguarded rewrite would have emptied it and
made a five-deployment census look complete. Dropping an entry requires an
explicit override and is reported by name. One further guard: a read taken
at a block before the recorded deployment describes nothing and is refused;
and an address that holds no code at the block being read is never treated as
empty at all — on every chain in the inventory a contract keeps its code once
deployed, so such a record names no contract and is reported as a gap in
coverage to be corrected, never as a proof.

The manifest also has exactly one writer now, shared by the deploy scripts and
the census, and it takes a lock before it reads. Review found that two chains
being redeployed at the same moment could each record their own retired
contract and overwrite the other's — both reporting success, and the committed
inventory quietly one contract short. That was reproduced before it was fixed:
twelve simultaneous records through the old writer left three. The shared
writer serializes the records, writes the file in one step so a reader never
sees it half-written, and reads it back before it reports a record as made;
twelve simultaneous records now leave twelve. A deploy that cannot take the
lock stops before it moves anything.

Two smaller corrections from the same review. The reading of a contract's
routing history now describes itself as what it is — a check that can rule a
record *in* but never rule one *out* — so a report can no longer carry a nested
"proven" beside an undetermined verdict for a consumer to mistake for the
answer. And when a chain has to be re-read at a safer block, the failures
recorded during the first attempt are discarded along with its results, so a
chain that recovers on the second attempt is not still reported as failed.

Regenerating the report surfaced one more thing the census now refuses. A public
endpoint answered "what is the latest finalized block" with a height about a
month older than the one it had given ninety minutes earlier — not an error,
just a stale answer from one of the machines behind the address — and the
report would have been rebuilt on state a month older than the version it
replaced, labelled as current. The census now reads the heights recorded in the
committed report before it starts and refuses to read any chain at an older
height than that, retrying for a fresher answer and otherwise reporting the
chain as failed. Each chain's result also names the endpoint that served it.

Including the archived contracts also surfaced what an "archived deployment"
can actually be. Some are complete earlier versions of the platform; some are
bare shells where deployment was abandoned before any logic was installed; and
one recorded address turned out to hold an unrelated contract altogether. The
census now distinguishes these by what the contract itself says when asked —
but it does not settle a bare shell on that basis. A shell with no reading
function installed today may still hold records written before those functions
were removed, and its storage cannot be read without one, so it is reported as
unresolved pending an authoritative read of the records themselves. An address
that answers like something other than the platform is reported as undetermined
with a note to correct the record. Before counting anything the census also
checks whether code exists at the address — at a block known to be after the
deployment — and records how much VPFI the contract holds; the latter is
reported as *backing* set against what the records claim, never as a
settling fact.

The last point concerns what a chain's routing history can and cannot prove.
No amount of checking that a history looks complete can rule out a gap whose
net effect was nothing — an addition and removal both omitted — and such a gap
can hide exactly the holding being looked for. So where the relevant view is
absent, the census treats neither a clean-looking history nor an empty balance
as proof: the record can only be shown absent by reading the record, and until
that read exists those cases are reported as undetermined. Two further
operating rules landed with this: a chain is read at one block identity, and if
an endpoint forces a fallback to a newer safe block part-way through, every
result already taken for that chain is discarded and the chain is read again
from the start; and when a redeploy archives a prior contract, the archive step
itself records it in the committed inventory — before anything is moved, after
first recording any archive an earlier interrupted run left unrecorded — so a
fresh checkout can never find the inventory silently short. The census reads
that inventory as the union of chains still deployed and chains it lists, so a
retired chain's earlier contracts are counted rather than dropped, and the
mainnet deploy's clean-tree check no longer trips on the inventory the deploy
itself just updated.

Two claims were also corrected in the surrounding design. An empty population
retires the *migration* — there is nothing to move, and the shortfall question
that would have gone to the owner does not arise — but it does not retire the
protective changes that keep future holdings out of the shared balance in the
first place. Those producers are still live and can create a qualifying record
the moment after the census reads zero, so that work ships regardless. Review
then tightened even the first half: a record created after the census but
before the protective changes land would have nowhere to be moved to once the
moving code is gone, so the report now states plainly that the migration is
retirable only by a census taken after those producers were frozen, or after
the protective changes are deployed, and says which deployments still have
live producers.

Five further corrections from that review round. Regenerating the archived-
contract inventory now gathers its list while holding the same lock the deploy
scripts take, so a redeploy recording its retired contract at the same moment
cannot be overwritten. The testnet deploy script's repair of unrecorded
archives now runs on every fresh redeploy, not only when a live record exists —
the case it repairs is precisely the one without a live record. A prior report
that cannot be read now stops the census rather than quietly removing the
floor that keeps a report from going backwards, and the report is written in
one step so an interruption cannot leave a half-written one. The check that the
block being read is still the block that was pinned now runs before every
early "proven" result, not only after a full enumeration. And one more comment
describing the routing-history reading as a proof was retired.

The next round closed two races in the census itself. Its inventory of
deployments is now taken in one step while holding the same lock the deploy
scripts take, so a redeploy recording and retiring a contract at that moment
cannot fall between the two lists and go uncounted. And the committed report is
replaced under a lock that re-reads the existing file first and refuses to
overwrite a report that was read at a later block on any chain — two censuses
finishing out of order can no longer have the older, emptier one win — and
that check now also refuses a report that would drop a contract the committed
report already covers, not only one read at an older block. Recovery from a
crashed writer's abandoned lock was also made single-winner, so two writers
recovering at once can no longer end up writing at the same time.

A further round made changing *which contract* an archived record names an
explicit, recorded act: neither the inventory nor the report will silently
replace a retired contract's address under the same label, since the displaced
contract may still hold custody; the operator must name the address being
displaced, and the report keeps it on record beside its replacement. Two
records naming the same contract now share a result only when they carry the
same scoping metadata, and recovery of an abandoned lock whose owner never got
written now works.

The round after that tightened the same places once more. An address with no
code is now treated as empty only when the chain shows it held code at the
recorded deployment block — otherwise the record may simply name the wrong
address, and the real retired contract would go uncounted. Changing which token
a record is scoped by is now an acknowledged, recorded change like changing its
address, and those records survive every later report rather than one. The
inventory is re-checked at the moment the report is written, so a redeploy that
began and finished during a census cannot leave a verdict about a population
that has since changed. And a writer that stalled long enough to be mistaken
for dead can no longer wake up and write alongside the writer that took over.

The lock's recovery rules were then rewritten rather than patched again: the
record of who holds the lock is the lock, only its holder ever clears it, and
taking over an abandoned one replaces that record in place — so no two writers
can ever both believe they hold it, and none can strand it. The inventory check
made at the moment a report is written now stays under the inventory's lock
until the report is in place, compares every field of every record, and a
deliberate change of which contract an archived record names is acknowledged
one record at a time rather than by a blanket override.

A displaced contract now stays in the inventory as its own record and keeps
being censused — an address that was corrected away is still a contract that
can hold custody, and a note in a report is not a scan. And each deploy now
records, under the inventory's lock, that it has published a new live contract,
so a census cannot report its inventory as unchanged across a deployment that
finished while it ran.

The last inference the census drew from a deployment record is gone too. Where
a contract no longer answers which token it treats as VPFI, the record's token
had been used to decide which holdings counted; but that token can have been
rotated on the contract before the answer was removed, so a holding in the
newer token would have been filed as out of scope and the category settled
wrongly. The record's token is still used to read and list holdings, so a
reader can see what would have been counted, but the two categories that
depend on it are now reported as undetermined unless the contract itself
supplied the token. One live deployment is affected and moves to undetermined
on those two categories. Two reports that read different block hashes at the
same height now refuse to replace each other as well.

One operational fix surfaced by the regenerations themselves: two full runs
were lost to a public endpoint that kept serving the census from a single
out-of-date machine, because the connection was reused for every retry. The
census now opens fresh connections when it retries, so a retry can land on a
healthy machine instead of the one that just failed. It also chooses the
block it reads from more carefully: the endpoint's machines can be far apart
in how much of the chain they have, so the census asks several of them which
block is final and takes the lowest answer, and if a machine still turns out to
be behind that, it re-reads the whole chain at the height that machine has —
which is still a final block — rather than failing the run. When even that
could not find a block the endpoint's machines all had, the census reported
the chain as failed rather than guess, and that chain's default endpoint was
moved to one that served every reading cleanly; each report names the endpoint
that served each chain.

Two further refusals were added to the rules that decide whether a new report
may replace the committed one: machines that disagree about which block sits
at a given height are refused as inconsistent, and a report read at a later
block replaces an earlier one only when the earlier block is shown to be part
of the later one's history, so a fork can never overwrite what was recorded on
the other branch. Those rules now live in a small, self-contained piece of the
tool with each one covered by a test. The "part of its history" check is now a
real proof — the tool walks the chain of blocks between the two reports and
checks that each links to the one before it — rather than a single question to
an endpoint that could answer for a different fork. And a deploy now announces
that it is about to publish a new contract record before it does so, and
withdraws the announcement afterwards, so a census that looks in between knows
to wait rather than report an inventory that is about to change.

Review then found the population itself was one short: the quick rehearsal
deploy sets a retired contract's record aside under a different name that the
census never looked at, and one such record — an earlier Optimism Sepolia
deployment from May — was sitting on the operator's machine in no inventory.
Those records are now counted, that deploy records them before setting them
aside, and the inventory grew to fifteen archived contracts and twenty
deployments in all. The deploy's announcement of a publication is now signed
with a token only that deploy holds, so no other deploy can withdraw it, and
the history proof is re-checked against the exact report being replaced and
the exact block each chain was finally read at, just before writing.

Finally the announcement protocol is enforced at the point of writing rather
than trusted to the scripts: the deployment record's identity fields can only
be written by a deploy that has made the announcement, so the direct broadcast
the older documents showed now stops before it changes the record, and those
documents route every deploy through the wrappers. A deploy that appears to
have died is no longer overwritten automatically either, since its broadcast
may still be running; taking over is an explicit operator act.

Three more doors closed afterwards. The switch that lets a local experiment
deploy without recording anything is now honoured only on the local chain or
under the test runner, and a real deploy that carries it stops before sending
anything, so no deployment can reach a chain unrecorded. Taking over a
seemingly dead deploy is verified against the durable identity its processes
keep even after the shell that started them is gone. And when the census must
step back to a block a lagging replica can serve, it first proves that block is
an ancestor of the finalized one, rather than assuming a lower number is safe.

Every state the census reads is now tied to one specific block by its
fingerprint rather than by its height, so two servers that disagree about
what happened at a height can no longer contribute pieces of one snapshot;
the fingerprint is also checked across several fresh connections before any
verdict is written. The evidence that a recorded address was once a contract
was then found to certify a state that cannot exist: on every chain in the
inventory a contract keeps its code forever once deployed, so an address with
no code never hosted one, and such a record is a gap in coverage to be
corrected rather than a proof of emptiness. The census now says exactly that.

Refs #1566, #1349, #1956
<!-- assembled-fragment: 1566-grandfathered-custody-census.md sha256=b626d810cbcedbc8b0b603eccfbde9a6e79f8053facd44181d86ed4a7a0820cd -->

## Thread — the reward-mesh role becomes a recorded fact, not an inference (#1566)

A chain's role in the reward mesh used to be worked out from two configuration
values: it was a "mirror" if it was not marked canonical and it named a
canonical chain. That leaves a case the expression has no answer for — a chain
that is neither. Fourteen places in the reward code asked that one question and
each decided two different things from the answer (am I bounded, and do I
record what I pay), so the unhandled case failed in two directions at once. A
chain in it was treated as unbounded for the purpose of paying rewards out,
while every writer that tracks what has been paid went quiet.

Naming that state is not enough on its own, and this change is mostly about
why. The condition "not canonical and no canonical chain named" does not
describe one situation but two, and they need opposite treatment. A chain that
*was* in the mesh and was later detached from it has already spent funding it
cannot earn back, so it has to stop paying. A chain that was simply never put
into the mesh is an ordinary single-chain deployment with nothing delivered to
it, nothing owed, and nobody to report to — it has always operated normally and
must continue to. From the outside the two are indistinguishable: the stored
values are byte-for-byte identical.

This is not a hypothetical distinction. Reading the live configuration of every
deployed chain while preparing this work found two of them — the Arbitrum
Sepolia and BNB testnet deployments — sitting in exactly that state today.
Treating the state as "detached" and failing closed, which is what the design
called for before this correction, would have frozen every reward consumer on
both.

So the role is now **recorded when it is set** instead of being reconstructed
afterwards. The two administrative actions that can change a chain's role are
the only way into the detached state, and both now note that the chain has been
placed in a role at all. That single piece of information is what separates
"detached" from "never configured", and because it is written at the moment of
the change rather than deduced later, the four roles are exhaustive by
construction. Existing deployments need one explicit migration step, and an earlier
version of this note said they needed none. The field that records the role
did not exist before this change, so a deployment that had been placed in a
role and then removed from it under the old configuration carries no record of
that — and would read as never configured, which is the permissive case, when
it must read as detached, which is the closed one. Nothing on-chain can tell
those two apart, so the in-place refresh now requires the operator to declare
each chain's role, reads the resolved role back while the contract is still
paused, and applies exactly one correction: a chain declared detached that
reads as never configured is recorded as detached. Any other disagreement
between the declaration and the contract stops the refresh rather than
guessing. A chain the operator declares never configured needs no call and
keeps its single-chain behaviour, which is correct for it.

The delivered-funding bound now answers for all four roles from one place, and
several call sites that re-derived the role locally were collapsed into asking
it. That is not a tidy-up: each of those sites was a place where a role could
be honoured in one branch and missed in another, and one of them was the
fail-open path itself. Because the bound already answered correctly for the
roles those branches were protecting, removing them changes nothing for
canonical, mirror and unconfigured chains while closing the gap for detached
ones.

Finally, the resolved role is now readable on-chain. The raw configuration
values are not sufficient to determine it — that is the whole point — so an
operator inspecting a deployment previously had no way to tell the two
ambiguous states apart. Neither did the code, which is how this defect lasted.

Scope note: this lands the role resolver and the detached-chain behaviour that
needs no further machinery. The refinements that draw on retired-era balances
and prepared transport coverage arrive with the funding work they depend on;
until then a detached chain bounds at zero, which is the safe direction and is
unreachable on any chain deployed today.

Refs #1566, #1349, #1956

Two later corrections from review. Re-asserting "not canonical" on a chain
that was never configured is now a genuine no-op: it does not record the role,
so it cannot silently move such a chain into the detached state and its zero
bound. And the operator documentation now says precisely what detaching stops:
payouts funded from delivered-fresh budget, and only those — schedule rewards
already due and recycled-funded legs still settle — so an incident that needs
every reward outflow stopped is directed to pausing the reward facets instead.

One more correction from review: zeroing the base chain on a chain that is
itself the canonical one does not detach it, because the canonical flag takes
precedence; such a chain is detached by clearing that flag, and the operator
documentation now says which write detaches which kind of chain.

The operator procedure for detaching a canonical chain now states both writes
and their order: clear the base first, then the canonical flag; the reverse
leaves the chain acting as a mirror, with delivered-fresh payouts enabled, in
between.
<!-- assembled-fragment: 1566-reward-role-resolver.md sha256=287bbb2233e20111de9c246b107d7fd4d7a0a8d152df3031f46830a122466017 -->
