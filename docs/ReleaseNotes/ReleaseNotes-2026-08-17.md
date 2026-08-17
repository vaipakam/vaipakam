# Release Notes — 2026-08-17

One entry, and it is about the notes themselves. The tooling that assembles this
file now checks that each fragment it folds in actually belongs to the date on the
file — a thing it never did, and which had quietly misfiled a day's work twice.

Worth reading for one reason beyond the fix: the same class of mistake it
addresses is the class it kept making while being written. A query that cannot
answer a question returning a confident answer anyway — that a fragment was never
committed, that a repository has full history, that a broken checkout is a clean
export — was the shape of every defect found across ten review rounds, several of
them inside fixes for earlier ones. The result is a tool that stops and says what
it could not establish, rather than proceeding on a plausible guess and then
deleting the evidence.

This file is itself the first product of that: assembled by the new code, from a
shallow checkout, which the first design of the guard would have refused outright.

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
