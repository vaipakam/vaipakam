# Release Notes — 2026-09-22

One merge, finishing the database move the previous day's notes describe.

The move leaves the old database in place and keeps comparing it against the
new one, because work suspended across the move can still commit afterwards.
That comparison — and the documented way back, which consults the same record
before reversing anything — is only meaningful against a record of what the
old database held at the moment of the move. Producing that record used to
require writing to a database, which after the move is the live one. This
release makes it obtainable by reading alone, and makes the record state what
it does and does not stand for rather than leaving either to be assumed.

# The record a database move is checked against can be taken again

Moving the platform's off-chain database leaves one obligation behind: the old
database is kept, and it keeps being compared against the new one, because work
suspended across the move can commit afterwards. That comparison is only
meaningful against a **record of what the old database held at the moment of
the move** — and so is the documented way back, which consults the same record
before reversing anything.

Until now the only thing that produced that record was the copy itself, and the
copy writes. After the move the destination is the live database, so
re-producing a lost record would have meant overwriting the live database's
newer rows with the old one's — worse than the problem it was solving. The
record was, in effect, irreplaceable, sitting in the middle of a recovery
procedure. That is the kind of thing that should not be irreplaceable.

It can now be taken directly from the old database, reading only, writing
nothing.

**What it cannot do is prove the database has not changed since the move, and
it no longer implies otherwise.** Consider the very case the ongoing comparison
exists to find: work suspended across the move commits afterwards, and the old
database then goes quiet. Every check available today passes — it is not
changing, nothing is connected to it — and a record taken now *contains that
late write*, so every future comparison treats it as original and can never
report it. Stillness now says nothing about what happened earlier.

So a record taken this way is always marked **not covering** the gap since the
move, and nothing about the command that takes it can say otherwise. A separate
step promotes it, and only by actually comparing it against the figures
recorded at the time — both the content of each table and the counters that
hand out new identifiers. Those counters matter on their own: a record created
and deleted again after the move leaves every table's content identical while
the counter has moved on, so content alone can never establish that nothing
happened.

A record is also refused if it catches the database moving while it is being
read. Reading a database table by table takes time, and a record assembled
across a database that is still changing describes no moment that ever existed —
it would hold one table as it was at the start and another as it was at the end.
So everything is read twice and has to agree: the set of tables, each table's
contents, the counters that hand out new identifiers, and the shape of each
table, which is checked both before its rows are read and again afterwards. A
column added and filled in between those two readings would otherwise leave the
contents looking identical, because the new column is simply not in what was
read.

**That is change detection, not a single instant's photograph of the whole
database, and the difference is worth stating plainly.** There is no way here to
freeze everything at one moment, so two gaps remain and are named rather than
implied.

A change to the **contents** of a table that has already been read twice, made
while later tables are still being read, would not be caught — its rows are not
read again, and nothing else it touches moves.

And each kind of reading has a **first** observation, which cannot see a change
completed before it. The record says it was taken from a moment early enough to
precede every reading it contains, so a table created and filled in the gap
between that moment and the first reading of the table set appears, identically,
in everything that follows — and looks original.

**What two equal readings establish is that they agreed, which is weaker than
nothing having happened.** A row can be added and removed again, or changed and
changed back, between them; the second reading then matches the first and the
record is accepted. Nothing here can see that, because nothing here watches —
it compares. So the honest form of the promise is: every check reports that its
two readings agreed, and a database that was genuinely still is the only reason
they should.

Within those bounds the coverage is broad: the table set and the shape of every
table are each read once more after all the row reading is finished — as one
reading of the whole database, not table by table, so a change landing on a
table whose own checks have already passed is still seen — and the identifier
counters are compared across the entire read.

But the procedure's real protection is that it is run against a database
nothing is writing to. These checks exist to catch that precondition having
failed, not to stand in for it.

The same care applies to the figures recorded at the time of the move, which may
be several runs' worth of output. Two runs that disagree are not a later reading
correcting an earlier one; they are proof that something changed in between, and
neither can then stand for the moment of the move. A table that one run lists and
another does not is the same proof — including a table named only in a final,
cut-off run, which is still a table that was not there when the database was last
listed in full.

Each reading of the old database now stamps the same short identifier on both
of the lines that close it, so the record itself says which figures were taken
together. Two halves of one reading can then be told from halves of two —
figures taken minutes apart, with an identifier handed out and given back in
between, which is exactly the change the counters exist to catch. Records made
before that identifier existed carry none, and are not rejected for it; the
promotion simply states that it could not establish the two halves belong
together.

The comparison also covers how each table **identifies** its rows, not only what
they contain — a table rebuilt with a different key over the same values holds
the same contents and would otherwise pass, while everything that reads the
record afterwards sorts rows by the part that changed. Records made before that
was captured cannot be re-made, because the moment they describe has passed, so
they are not rejected; instead the promotion names the dimensions it actually
compared, and says plainly which one it could not.

The promotion is refused outright, and the file left untouched, if any table is
short of either kind of evidence. A record that stays un-promoted is still
useful for spotting new differences; what it must not do is authorise the step
that copies the new database back over the old one, because a late change
absorbed into it would read as ordinary progress and be overwritten with
everything reporting success.

The statement of what a record stands for is written **into the record itself**,
not into a log that can be separated from it, and the comparison repeats it back
rather than describing a reconstruction as the original.

Verified against the real thing: a record taken this way after the move was
compared against the one the copy produced during it — 43 tables, **no
differences at all**.
<!-- assembled-fragment: 2281-reproducible-cutover-baseline.md sha256=6c734072481e58ad6d9fe5c93962bbe8a79bf43a5cf95cca2f3679305ffc1165 -->
