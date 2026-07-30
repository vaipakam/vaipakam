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

Turning that same reasoning on the check itself removed forty-four findings it
should never have reported. It had been treating any reference beginning with a
dot as relative to the citing document, which quietly swept in ordinary
configuration filenames and dot-directories — a correct reference to a real
file was being reported as missing, and forty-four of those wrong answers had
already been frozen into its own record of known findings. A frozen false
finding is the worse half of that bug: it is a permanent lie about the tree,
sitting inside the thing whose whole job is to tell the truth about it.

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

Review also found two ways the record could be gamed. It could be raised in the
same change that introduced a new one, which would have let the check be
silenced by exactly the move its own documentation forbids. And a known finding
could be quietly relocated: remove one stale reference, add a different one
further down the same document, and the record looked untouched even though a
new wrong instruction had landed.

Both are closed. The record is compared against the state of the branch the
change is merging into and any addition is refused; renames are followed, so
renaming a document is not mistaken for one; and it fails rather than shrugging
when it cannot work out what to compare against. And a finding is now identified
by the wording of the line that carries it rather than by a bare count of how
many times the same reference appears, so a relocation reads as what it is.

Identifying a finding by its line's wording had to be done without making
ordinary editing painful — rewording a sentence that happens to contain one of
the two hundred known references must not fail the check, or the check is the
thing that gets deleted. So the two questions are answered differently on
purpose: "is this reference new" by the wording, "did the record grow" by the
count. One consequence is stated rather than left implied — deliberately moving
a known reference elsewhere in the same document *and* regenerating the record in
the same change will pass, and is caught by reading the record's diff rather than
by the machine.

### Limits stated in the check itself

Because treating a clean run as proof is the habit it exists to counter.

It establishes only that a reference resolves, not that it is the right one. It
cannot vouch for the record that the very change establishing it lays down,
since there is nothing earlier to compare against — it says so when it runs, and
that initial set is taken on human review. And it currently reports rather than
blocks, so a warning will not by itself stop a new instance being merged;
turning it into a gate is a one-line change once the signal has been watched for
a while.
