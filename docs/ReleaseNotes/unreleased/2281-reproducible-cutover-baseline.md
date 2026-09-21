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
nothing. Taken this way it records that database **as it is now**, which stands
in for the original record exactly when the database has not changed since —
true of one that nothing is connected to any more. The tool says that plainly
rather than implying more: it cannot establish that the database has held
still, and it tells the operator to establish it and to write down which moment
the record stands for.

Verified against the real thing: a record taken this way after the move was
compared against the one the copy produced during it — 43 tables, **no
differences at all**.
