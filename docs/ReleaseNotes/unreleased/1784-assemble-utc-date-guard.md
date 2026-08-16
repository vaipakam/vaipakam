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

Three ways of reading the wrong day back out of git are closed off. A shallow
clone is refused outright: a fragment older than the shallow boundary reports
the boundary commit's date instead of its own, which looks entirely ordinary
and is wrong — worse under selection than under a refusal, because it would
quietly pull the wrong fragments into a day. A renamed fragment is followed
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

The assembler also now has a test suite of its own, wired into the docs-drift
workflow so it runs on every pull request. It builds throwaway repositories
with fragments committed at chosen UTC timestamps and drives the real script
against them, covering the two-day backlog, the empty-day refusal, the
override, the shallow clone, the uncommitted fragment, a checkout with no git
at all, and argument handling. Both of the failures above were the kind a
reader cannot check by eye — the output looks ordinary either way — which is
the argument for asserting them rather than reviewing them.
