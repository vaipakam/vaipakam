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

So taking a record this way requires the operator to state, in one line, which
moment it stands for and what establishes that — the figures recorded at the
time of the move, or an honest admission that the interval is not covered. That
statement is written **into the record itself**, not into a log that can be
separated from it, and the comparison repeats it back rather than describing a
reconstruction as the original.

Verified against the real thing: a record taken this way after the move was
compared against the one the copy produced during it — 43 tables, **no
differences at all**.
