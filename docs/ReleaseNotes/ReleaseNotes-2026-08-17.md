# Release Notes — 2026-08-17

Three entries, and a theme runs through all of them: a check that cannot actually
establish what it claims is worse than no check, because it reports success.

The first is about these notes. The tooling that assembles this file now verifies
that each fragment it folds in belongs to the date on the file — something it never
did, and which had quietly misfiled a day's work twice. The same class of mistake
it fixes is the class it kept making while being written: a query that cannot
answer a question returning a confident answer anyway, whether that a fragment was
never committed, that a repository has full history, or that a broken checkout is a
clean export. That shape accounted for every defect found across ten review rounds,
several of them inside fixes for earlier ones. This file is itself the first product
of the result: assembled by the new code, from a shallow checkout, which the first
design of the guard would have refused outright.

The second splits the component handling a lender's two ways out of a live loan into
two, because it had reached thirty bytes below the hard size limit the chain
enforces — less than the cost of a single call between components, which is the shape
almost every pending fix to those routes takes. Three queued corrections had all
been measured and each was individually too large to deploy. Nothing about either
route's behaviour changes; what changes is that both now have room to be fixed.

The third makes every change to a loan's status announce itself from the single place
all such changes are required to pass through. That chokepoint already existed and
was already enforced, and it had exactly one observer — so an off-chain reader could
only watch whatever a calling component chose to announce, and a component that
announced nothing left the loan looking open forever. A change that emits nothing is
invisible to the automated coverage check too, which is the same failure the first
entry is about, in a different subsystem. It is now impossible to construct a status
change that nothing can see.

## Tooling — the release-note assembler files fragments by their own UTC day

The assembler folds pending fragments into a file named for a date, and until
now it never checked whether the fragments belonged to that date. It took
whatever was sitting in the pending directory and wrote it under whichever day
it was told. That is fine when the two agree and silently wrong when they do
not.

They disagree in a specific, recurring window. A fragment belongs to the day
its pull request merged, measured in UTC — the same clock the assembler uses
when no date is passed. The operator, though, reads merge dates in local time,
and at `+05:30` every merge between 18:30 and midnight UTC displays a local
date one day ahead. Assemble on the local day and those fragments land in a
file dated a day after the day they actually shipped.

That has now happened twice. The first time it was caught in review and the
grouping corrected before merge; the second time it was caught by hand while
preparing the following day's assembly. On both occasions the tooling said
nothing — there was no failure to notice, just a file with the wrong date on
it. The information needed to catch it was available all along: each
fragment's own add-commit records when it arrived, in UTC.

So the assembler now reads that commit for every pending fragment and takes
only the ones belonging to the day being assembled. Anything from another day
is named, told which day it belongs to, and left in place. A backlog spanning
several days is cleared by running the assembler once per day, and each day's
file contains that day's work.

Selecting rather than refusing matters more than it might sound. An earlier
draft of this change refused the whole run whenever two days were pending,
which would have made a mixed backlog impossible to assemble at all: every
date's run sees the other day's files and stops, so neither day can be
produced without moving files by hand — and a mixed backlog is precisely the
situation the dating exists to handle.

A `--allow-mixed-dates` flag takes every pending fragment regardless of day,
for when folding them together is deliberate. A fragment that has never been
committed is always taken, since that is one written and assembled inside the
same pull request and has no day of its own yet.

Several ways of reading the wrong day back out of git are closed off. Shallow
history is the subtlest: a fragment older than the shallow boundary reports the
boundary commit's date instead of its own, which looks entirely ordinary and is
wrong. Only that fragment is refused, and by name — one added after the boundary
has a real add-commit and is dated normally. Refusing every shallow clone was
the first attempt and proved too broad to be useful, because continuous-
integration checkouts are routinely shallow: the realistic outcome was an
operator reaching for the override on every run, and an override that turns the
dating off protects nothing. A renamed fragment is followed
back to where it was written rather than dated to the rename, which matters
because fragments are routinely renamed to match their pull-request number
once that number is known, often on the following day — including a rename
staged but not yet committed, which no amount of history-following can
resolve on its own, since git can only pair the two names through the index.
Where even the index cannot pair them — pairing is similarity detection, and
a rename plus a substantial rewrite falls below the threshold — the run says
what it saw rather than guessing, because a heavily-rewritten rename and a
deliberate replace are the same two records. A filename that has been used
before is dated as new rather than inheriting the day of whatever fragment
held that name previously, since history is keyed by path and an
assembled-and-deleted name keeps its add-commit indefinitely. And a
repository whose
history cannot be read at all now stops the run: an unreadable history and a
never-committed fragment both come back empty, and treating the first as the
second would have filed the fragment under an unverified date and then deleted
it.

Underneath all of that sits one rule: when git cannot answer the question, the
run stops rather than guessing. The rule has to cover the QUESTIONS as well as
the answers, which took two passes to get right: asking whether the repository
is shallow can itself fail, and a failed ask returns nothing, which is not the
word "true" and so reads as "not shallow" — the truncation check then never runs
at all. The same shape one level down: a checkout whose git metadata is a broken
link is unreadable to git, yet the ordinary test for "does this exist" follows
the link to the missing target and reports nothing there, so a damaged
repository was classified as a clean export and every fragment consumed. Both
now abort and name what could not be established. An unreadable index, an unreadable HEAD, an
unreadable history and a damaged checkout each used to produce a plausible
wrong answer — no renames staged, fragment not committed, fragment newly
written, this is an export — and each of those answers led to a fragment being
filed under an unverified date and then deleted. They now abort and say which
question could not be answered. A damaged checkout is distinguished from a
genuine export by looking for the metadata rather than trusting the probe.

The assembler also now has a test suite of its own, wired into the docs-drift
workflow so it runs on every pull request. It builds throwaway repositories
with fragments committed at chosen UTC timestamps and drives the real script
against them, covering the two-day backlog, the empty-day refusal, the
override, the shallow clone, the uncommitted fragment, a checkout with no git
at all, and argument handling. Both of the failures above were the kind a
reader cannot check by eye — the output looks ordinary either way — which is
the argument for asserting them rather than reviewing them.

## Lender early-withdrawal is split into two facets so either route can be fixed again

The lender's two ways out of a live loan — selling the position straight into a
standing lender offer in one transaction, or listing it and waiting for a buyer
— lived in one on-chain component. That component had reached thirty bytes of
room under the hard per-component size limit the chain enforces. Thirty bytes is
less than the cost of a single call from one component to another, which is the
shape almost every pending fix to these routes takes. In practice the routes had
become unfixable: three queued corrections had all been measured, and each one
on its own was too large to deploy.

The two routes are now separate components. Nothing about either route's
behaviour changes, and nothing about how they are called changes — the platform
still presents one address, the same state is shared, and a caller cannot tell
the difference. What changes is that each route now has thousands of bytes of
room instead of thirty, so the queued corrections can actually ship.

The seam runs between the two routes rather than through either of them, for two
reasons. The routes are separate choices a lender makes, with no shared
internals: each one's helpers are used only by it. And the listed route's own two
halves — putting a position up for sale, and completing the sale once a buyer
takes it — are the opposite case: they share the listing's binding, its
one-at-a-time rule, and its relist cooldown, so they are only correct when read
together. Splitting between those two would have freed more space and been the
wrong cut, turning a rule that can be checked in one place into one that spans
two.

This is the second time a component has been split for this reason. Rather than
record it as a one-off the way the first one was, the specification now states
the rule that governs where such a seam goes — follow a boundary the product
already has, and never separate two halves that share an invariant — so the next
one is a decision with a written basis rather than a judgement call made under
deadline.

Three error conditions that both routes can raise moved to the shared error
definitions both components inherit, so the split did not duplicate them. That is
what those shared definitions exist for, and a duplicated error is the kind of
thing that drifts apart silently. The visible cost is that every component
inherits those definitions, so the machine-readable interface files the apps
read all pick up three new entries — a wide but entirely mechanical change,
worth flagging so a reviewer seeing forty-odd touched files knows what they
are.

Alongside the split, four rules that govern every lender exit moved to where they
apply. They had been written into the listed route's section as that route was
built out — an offer past its deadline cannot be filled, a party must not end up
owing itself, a buyer must not enter at or after the loan's due date, and one
position must not be sold through two routes at once — which meant a reader of
the direct route never met them. They now sit in the section the specification
already had for rules shared across every exit route, stated without reference to
a particular route. Nothing about either route's intended behaviour changed; what
changed is that a reader of either one now sees the rules that bind it. Rules that
are genuinely specific to a listing stay with the listing.

This also corrects a finding recorded earlier the same day, which had claimed the
direct route was missing from the specification entirely. It was not: it has a
full section covering who may sell, what must hold before a sale, how accrued
interest and any rate shortfall are treated, what the seller must be shown before
confirming, and what the borrower experiences afterwards. The earlier claim came
from searching the specification for a function name — and the specification is
deliberately written without function names, so that search could only ever have
come back empty. The real gap was narrower and is the one described above.

One consequence to expect rather than puzzle over. Moving those three shared
error definitions means every component's machine-readable interface picks them
up, and two of the four components the public reference keeper bot reads are
among them. That bot lives in its own repository on its own release cadence, so
its committed copies now differ from freshly compiled ones and the pre-deploy
gate will say so. It is advisory by design, not a blocker, and nothing about the
bot's behaviour changes: the functions it calls are untouched, and the three
errors are lender-sale conditions it never triggers. Worth a re-sync next time
that repository is touched; not worth holding a deploy for.

One operational note for redeployments: the two components must be refreshed
together. They were one component, so refreshing only the listed route would
leave the direct route running the code from before the split while everything
around it moved on — the same half-applied-family hazard the redeployment script
already documents for other paired components. The script now carries both.

A second, quieter consequence of the same split. There is a standing rule that a
redeployment script touching any component that hosts a sale must also reinstall
the routing for a shared check those sales call — get that wrong and the new sale
code goes live calling something nothing routes, so every sale fails. Four places
record which components those hosts are, and the split made that list one short:
the direct route is now its own host. No redeployment path was actually broken —
the script that touches these components reinstalls both halves and the routing
alongside them — but the list is what a future script's author would rely on, and
a list that quietly under-counts is the failure this rule exists to prevent. All
four now name three hosts, and say why the count is not something a compile can
check: the shared check is reached through a helper that is folded into whoever
calls it, so the set of hosts is "whoever calls that helper" and nothing verifies
it mechanically.

## Every loan status change now announces itself, from the one place they all go through

A loan's status can only be changed in one place. That has been true for a long
time and is deliberate — the intent is that there is exactly one spot to read
when reasoning about the lifecycle, and a status change that isn't in the
permitted table is rejected outright. What that one place did was update the
platform's own internal tallies. What it did not do was say anything out loud.

Anything watching from outside therefore could not watch the status change
itself. It could only watch whatever announcement the surrounding operation
happened to make. Most operations make a good one. Some make none, and at least
one announces a different loan than the one whose status actually moved — the
temporary holding record used to carry a lender position from one lender to the
next ends its life silently, while the announcement names the original loan.

The consequence is a loan that has genuinely finished still showing as running,
indefinitely, on every surface that reads from an external index rather than
from the platform directly. On-chain everything is correct; the reader is simply
never told. This is the same symptom as a past incident where an index went
blind to loans ending, and it is reachable through the one blind spot in the
automated check built to prevent that incident recurring: that check works from
the list of announcements that exist, and an operation which announces nothing
is not a mis-tagged or unhandled announcement, so it never enters the list at
all.

The fix is to announce from the single place all status changes already go
through. This is not a new mechanism — the choke point exists, is mandatory, and
is enforced. It had one observer wired to it and now has two. What changes is
that a status change nobody can see is no longer possible to write: there is no
longer any individual operation that could forget, because none of them is doing
the announcing.

That distinction is why this was done at the choke point rather than by fixing
the one case that was found. The same class had already been patched by hand
twice, each time after somebody noticed a specific loan looking wrong. Both of
those remain handled explicitly, for the extra work they do that a general
announcement cannot know about; the point is that a third occurrence is now a
non-event. It also removes the need for a second, larger piece of tooling that
had been sketched to hunt for exactly this — with the announcement built in,
there is nothing left for it to hunt.

The cost was the reason this had been deferred rather than done. The platform's
components each face a hard size ceiling, and two of them had thirty bytes of
room, which is less than a single announcement costs. Splitting the larger of
those two, done separately, is what made this affordable. Measured afterwards,
the additions run between thirty and roughly a hundred and sixty bytes per
component — and the components with the least room to spare pay nothing at all,
because they reach the status change through a shared internal caller rather
than doing it themselves. The worst case is a hundred and sixty bytes into
seventeen hundred free.

On the reading side the new announcement is treated as a safety net rather than
a replacement. The existing handlers keep doing the work only they can do, such
as clearing a related listing or looking up a loan under a different name. The
net does one thing: it makes sure no loan is left showing as running when the
platform says otherwise. It deliberately does not promote an already-finished
loan further along, because whether a finished loan is fully wound up depends on
both parties having claimed, and the handlers that know about claims are the
right ones to decide that.

The automated check demanded a handler the moment the new announcement appeared,
which is the whole point: the announcement enrolled itself in the guardrail, so
the gap closes for every future status change and not just for the one that was
found.

Two corrections landed after review, and the first changes when the net acts
rather than what it does. The net's update and one of the existing handlers'
updates both apply only to a loan still showing as running — that condition is
what makes each of them safe to repeat. Because the platform announces the
status change from inside the very operation the specific handler is watching
for, the announcement is seen first, and the net was therefore claiming that
condition before the specific handler could use it. The specific handler's
update then matched nothing, which mattered because that is the update which
also refreshes the loan's outstanding amount and collateral from a reading taken
against the exact moment of the change. The figures stayed stale, and a counter
reported a write that had not happened.

The net now waits until every specific handler has run, and only then fills a
gap none of them filled. That is what a safety net should be, and stating it as
ordering rather than as a special case means it holds for every handler, not
just the one that was found. It also repairs a second, sharper case for free:
where a loan is matched and then fully wound up within the same block, the net
now takes the last of those steps rather than the first, which is what the
platform's own end-of-block reading reports. Taking the first left such a loan
showing as matched forever, since nothing later corrects it — behaviour two
earlier fixes had specifically established, and which this change had been
quietly undoing.

The second correction is smaller and about reach rather than correctness. The
new announcement was being filed without the loan it belongs to attached, so the
per-loan history view could not find it. That is worst exactly where the
announcement is most needed: the temporary bookkeeping loan a lender sale
creates is named by no other announcement, so its history had no record of the
change at all. It is now filed under its loan.
