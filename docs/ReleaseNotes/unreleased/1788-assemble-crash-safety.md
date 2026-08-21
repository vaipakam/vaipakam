## Assembling the release notes twice no longer duplicates them

The script that folds each release's pending notes into one dated file does two
things that cannot be made a single step: it writes the dated file, and it
removes the notes it consumed. An interruption between them — or partway through
the writing — left the work half done in a way the next run made worse rather
than better.

Two distinct problems, now closed by different means.

If the run stopped **while writing**, the dated file was left partly appended to,
and a stopped-before-anything run could leave behind a file containing only its
heading. The next run then treated that stub as a real existing file and appended
to it. The file is now built off to one side and moved into place as the last
step, so it is either the previous version or the complete new one, and never
something in between.

If the run stopped **after writing but before clearing**, the content was already
in place while the source notes still looked pending — so the next run appended
every one of them a second time. That was the worse of the two, because nothing
failed and nothing was lost: it produced quietly duplicated prose in a published
document, caught only if whoever committed it happened to read the whole diff.
Each folded note now leaves an invisible marker in the dated file, so a later run
recognises what is already there, says so by name, removes those notes, and
appends only what genuinely remains.

The recovery for both is the same: run the script again.

One case needs a manual step first. Assembly holds a lock so two runs cannot
overlap, released whenever the script exits — including on Ctrl-C. A *hard* kill,
or the machine dying, leaves it behind, and later runs then stop until it is
cleared. That is deliberate: the lock guards a step that deletes files, so a
stale one is reported, with the exact command to remove it, rather than broken
automatically on a guess about whether the other run is still alive.

### What the marker records, and why it is not the filename

The first version of this recorded only the note's filename, on the reasoning
that recognising the *text* could not work once assembly had rewritten the links
inside it. That reasoning was wrong, and wrong in a way that authorised deleting
someone's work: the rewriting applies to what gets appended, while the marker
records the identity of the source, taken before anything is rewritten. Nothing
touches that.

A filename is neither stable nor unique to what is under it, and both failures
were real. A note edited after an interrupted run — the obvious thing to do when
resuming — kept its name, so it was recognised as already handled and deleted
unread, losing the edit. That is worse than the duplication this change exists to
prevent. In the other direction, a note *renamed* between runs was not recognised
at all, and its content was added a second time, which is the original bug by
another route.

The marker now records a fingerprint of the note's contents, so different text is
never mistaken for something already filed.

A fingerprint identifies the *text*, though, not which note it came from — and
two notes can legitimately carry the same short sentence, or reuse a filename
months apart. So the rule for removing a note without adding it is deliberately
narrow: its record must be in **the file being assembled**, under **the same
name**. That combination is the signature of an interrupted run and nothing else,
because resuming one means asking for the same day again.

Anything else stops the run and says what it matched and where. A different name
is a rename or a coincidence; a record in another day's file is a note reused
later, or one whose day moved because the clock passed midnight mid-recovery.
Each of those is two situations wanting opposite handling, and picking either
one can delete a genuinely new note and leave its day with no entry at all.
Stopping cannot duplicate and cannot delete; guessing can do both.

A note that merely *quotes* a marker in its prose — as this very note does — is
not mistaken for a record of one, either. Nor does a file that mentions the
marker's opening words in passing count as one that keeps records.

Every dated file is searched, not just the one being assembled. A run interrupted
shortly before midnight and resumed after it is aimed at a different day's file,
and looking only there wrote the same content into two of them.

### Where it genuinely cannot tell, it stops

A dated file written before any of this existed carries no record of what it
consumed, so the absence of a record means either "new" or "already filed, never
recorded" — and nothing in the file distinguishes them. Guessing either way is
wrong: one duplicates, the other deletes.

So when a file carries no records at all *and* already contains the heading of a
note about to be added, the run stops and asks, naming what it found and what to
check. `--force-append` overrides it. Where the file does carry records they are
authoritative, and the run proceeds — with a note on screen if a heading repeats,
since the superseded version is probably still further up.

Refusing a destination that is not a regular file belongs to the same instinct: a
directory sitting at the output path silently swallows the assembled file, and
the notes would then have been deleted for nothing. A symbolic link is refused
for a nearer-miss version of the same thing — replacing a file by renaming
another one over it replaces the *link*, leaving the file it pointed at
untouched while every note is consumed.

### Only one assembly at a time

Replacing the file and clearing the notes it consumed is now treated as a single
transaction, and two runs for the same day can no longer overlap. Each would
otherwise work from its own snapshot, and whichever finished second would
overwrite what the first had added — losing a note from the assembled file *and*
from the pending pile at once, with both runs reporting success. A second run now
stops and says so, including how to clear the marker if the first one died
mid-way.

That hold covers **all** assembly, not just the day being assembled. It first
covered one day at a time, on the reasoning that two days write to two different
files and so cannot collide — which missed that they draw from the same pile of
pending notes. A note not yet tied to a particular day is eligible for whichever
day is asked for, so two runs on different days can pick up the same one, and it
then lands in one file while being deleted out from under the other. What two
runs contend for is the pile, so that is what is held.

### A fragment cannot write the record, and a changed one is not deleted

Two smaller protections, both about trusting the wrong thing.

The records are what a later run believes about what has already been filed, so
a note is not allowed to contain one. Anchoring the reader stopped a record
*quoted mid-sentence* from counting, but a note could still put a complete one at
the start of a line — and once assembled, nothing distinguishes it from a record
the script wrote. One naming a note from a later batch would have that note
deleted unread, its text never written anywhere. Notes documenting the format can
still quote a record indented or in a blockquote, which is what the anchoring is
for.

And a note that changes *while the run is reading it* — an editor saving at the
wrong moment — is no longer removed. The assembled file holds the version read at
the start, and its record describes that version, so deleting the newer one would
throw away writing that never reached the file. Those are kept, named on screen,
and left for a human to compare.

### The protection the notes had, and the assembled file did not

Building off to one side and renaming into place is what makes an interrupted
run harmless, and it introduced a fault of its own that took until the last
review round to see. The run copies the existing dated file, appends to the
copy, and renames the copy over the original — so anything written to the
original in between is overwritten. The fragments are consumed, the run reports
success, and someone's edit is simply gone.

Holding the pending pile does not help. That keeps two assemblies apart; it
knows nothing about a person with the file open, or a script appending to it.

This was an inconsistency in the design rather than a considered asymmetry. A
*note* that changes while the run is reading it is already kept and reported —
that protection was added earlier in this same work. The dated file, which is
the published one, had nothing. It does now: its identity is recorded when it is
copied and re-checked immediately before the replacement goes in, and any
difference refuses the run with nothing consumed and every note still pending.
The shape checks are re-run at the same moment, because a path that *became* a
symbolic link since the run started would otherwise be replaced by the rename,
leaving the file it pointed at untouched while every note was deleted.

Refusing costs nothing here — the run has not consumed anything yet, so the
recovery is to run it again once the other change has settled, and it is built
on top.

### Two smaller ones from the same round

The replacement's bytes are now pushed to disk before the notes are removed.
Renaming is atomic for what a running system *sees*, which is not the same as
what survives a power cut: with write-back caching the deletions can reach disk
while the new file's contents have not, and the text is then gone from both
places. This one is best-effort by choice — it narrows a rare window and cannot
break anything by not happening, so failing an assembly because the flush is
unavailable would trade a rare fault for a common one. It is also the one change
here with no test behind it, because reproducing it needs a real power cut
rather than a shell script, and saying otherwise would be inventing coverage.

And a hard kill leaves the half-built copy behind, since no trap runs. It sits
in the release-notes directory where nothing else looks, and the `git add`
this script prints at the end would stage it for commit. Every later run now
names it — reported rather than deleted, on the same reasoning as the stale
lock: a temp file belonging to a run that is still alive is indistinguishable
from an abandoned one.

### Verified against the fault, not just the fix

Every test covering a **behaviour that changed** was run against the older
script first, and fails there: the interrupted-run case produces two copies of a
section where one is correct, an edited note is silently discarded, a renamed one
is duplicated, a failing checksum writes an unusable record. Then against the new
script, where each passes. A test for a recovery path that has never been seen
failing is a test that might be checking nothing.

Not every new test does that, and saying otherwise would overstate it. A few
guard against faults the *new* mechanism could introduce rather than against the
old behaviour — that a record quoted inside ordinary prose is not mistaken for a
real one, for instance. There is nothing to reproduce for those, because the
older script had no records to quote. They are guards against a regression, not
demonstrations of a fix, and they are worth having on those terms.

Several were checking nothing when first written, which is the part worth
recording. One used a note still tracked by version control, so an unrelated rule
held it back and the part under test never ran. One quoted a made-up fingerprint,
which matches nothing under any version. One stopped at an earlier failure and
never reached the step it named. Each looked correct. Each was caught only by
running it against the broken code and noticing it did not fail — which is now
the rule rather than a habit: **a negative assertion is not trustworthy until it
has been seen failing.**
