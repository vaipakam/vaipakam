### A stale documentation reference is now caught by a machine instead of by review

Review kept finding the same mistake in the operator documentation, in a
different document each time: a reference to a file or directory that no longer
exists. It is not the kind of mistake care prevents — nothing tells the person
renaming a directory which prose mentions the old name — so it is now
re-checked automatically on every change.

The application directory was renamed some time ago and one hundred and
forty-seven mentions of the old name survived across thirty-nine documents. An
operator following one looks for something that is not there, usually at the
moment they can least afford to.

The check also found seventy-eight links in the main specification that were
silently broken: they were written as though the reader were standing at the
top of the repository, but a link inside a document is followed relative to
that document, so every one of them led nowhere. Those are corrected here,
along with fourteen citations of test files that had moved into a subdirectory.

### Two companion checks were built and deliberately held back

Both are recorded with their findings rather than merged.

The first looked for a credential written into a command line, where anyone
else on the machine can read it while the command runs. It found ten times as
many instances as review had, so the problem is real and larger than anyone
thought — but deciding correctly whether a value reaches a command's arguments
turns out to need a proper understanding of shell syntax, and each round of
review found another case the approximation got wrong, including, at one point,
condemning the very pattern the documentation recommends.

The second checked whether documents cite app addresses in their current form.
It went through four rounds. Each round closed a real gap and the next found
another way of writing the same address that the pattern did not recognise — a
trailing slash, a language prefix, the full public URL. The ways people write
an address are open-ended, so a pattern over them can only converge by
exhaustion; what shipped instead asks a question with a definite answer, namely
whether a name is in a list of things that were removed, and whether a path is
in the repository.

Holding both back is the point rather than a compromise: **a check that is
sometimes wrong teaches people to ignore the one that never is.**

The address check did leave two results behind, and both are kept. Five stale
addresses it found are corrected here. And it disproved something that had been
asserted three times, including to the owner: that following one of those old
addresses would leave an operator staring at a blank page. It would not — an
unrecognised first segment is read as a language code and falls back to
English, so the page renders. They are the wrong address to publish, not broken
ones. The claim had been repeated because it sounded right, not because it had
been checked.

### Why it reports a backlog instead of demanding a clean slate

The check is not silent on the day it lands, because it describes a backlog
that already exists and is already tracked. Demanding that be cleared first
would have made it red on arrival, and a check that is red on arrival gets
ignored — which is worse than no check, because it looks like coverage. So it
records what it can see per document and reports only when a document gets
**worse**.

Freezing rather than clearing is also the correct answer for a second reason:
part of that backlog must not be cleared at all. Historical records — shipped
release notes, past findings, closed to-do entries — describe what was true
when they were written, and rewriting them to match today would falsify the
record. The clearest case is the design document that records the removal of a
directory: it has to name the directory it removed.

Review also found that the record of known findings could be raised in the
same change that introduced a new one, which would have let the check be
silenced by exactly the move its own documentation forbids. It now compares
that record against the state of the branch it is merging into and refuses any
addition, follows renames so that renaming a document is not mistaken for one,
and fails rather than shrugging when it cannot work out what to compare
against. One limit of that guard is stated plainly rather than left implied: it
cannot protect the very change that establishes the record, since there is
nothing earlier to compare against. It says so when it runs, and the initial
set is taken on human review.

### Two limits stated in the check itself

Because treating a clean run as proof is the habit it exists to counter. It
establishes only that a reference resolves, not that it is the right one. And
it currently reports rather than blocks, so a warning will not by itself stop a
new instance being merged — turning it into a gate is a one-line change once
the signal has been watched for a while.
