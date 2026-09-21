## Thread — the shared off-chain database moved, and the move was made all at once or not at all (PR #NNNN)

The platform's three background services and its nightly backup all read one
shared database. That database has been replaced with a different one. Nothing
a user can see changes; what changes is which database is behind it.

**The move had to be simultaneous, and a guard in the repository is what made
it so.** The database is named in four service configurations, in forty-three
operator commands spread across runbooks and deploy scripts, and in one script
that builds its command rather than spelling it out. A move that reached the
configurations but not the commands would leave a person applying schema
changes to a database nothing reads — and both halves would look correct on
their own. The guard refuses any state where those disagree, so the change
could not be done in pieces even if somebody wanted to.

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

The copy reported success both times. The only thing that caught it was
comparing row counts on both sides afterwards, which is why that comparison is
recorded here as part of the procedure rather than as a precaution someone took.

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
work rather than half-finishing it — the final copy is taken while nothing can
move, and only then do the services come back pointed at the new database.
Callers see a short refusal that says plainly that nothing they sent was
recorded, which is the intended behaviour and is why that mechanism exists.

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
