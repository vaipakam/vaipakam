## Tooling — the release-note assembler refuses fragments from another day

The assembler folds every pending fragment into a file named for a date, and
until now it never checked whether the fragments belonged to that date. It
took whatever was sitting in the pending directory and wrote it under whichever
day it was told. That is fine when the two agree and silently wrong when they
do not.

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

So the assembler now reads that commit for every pending fragment and refuses
to run if any of them belongs to a different day than the one being assembled,
listing which fragments and which day each came from. The fix is usually to
assemble each day separately. Where folding days together is deliberate — a
backlog being cleared, a day with a single stray fragment — a new
`--allow-mixed-dates` flag proceeds anyway.

A fragment with no add-commit yet is skipped rather than refused. That is the
case where a fragment is written and assembled inside the same pull request,
which is an ordinary thing to do and not something the guard should block.
