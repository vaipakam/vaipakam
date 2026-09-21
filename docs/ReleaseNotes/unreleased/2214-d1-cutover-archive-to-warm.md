## Thread — the shared off-chain database moved, and the move was made all at once or not at all (PR #NNNN)

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

If a fresh contract deployment does land later, the carried-over data becomes
stale exactly as the original decision anticipated, and clearing it then is one
statement per table. The original reasoning was sound for the situation it was
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
difference it names is applied by a person. That repeats until two consecutive
runs find nothing, and the old database is kept regardless, so a record
noticed a week later is still recoverable.

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
