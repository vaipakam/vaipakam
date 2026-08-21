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

A permission change arriving in that same window is caught too, and it is a
separate question from the content. The mode to give the replacement is worked
out before the build and applied to the copy — so someone restricting the file
to its owner while the run was working would have had that undone by the
rename, the replacement arriving wearing the older and *wider* mode. Nothing
about the content changed, so no content check could have noticed. This is the
fault the mode-preserving code already existed to prevent, reached through
timing rather than through a missing read.

It refuses rather than quietly adopting the new mode, matching the check beside
it: a permission change mid-run is somebody acting on the file deliberately, and
re-running takes the new mode as the starting point.

What remains between the last check and the replacement is a few system calls.
That is as narrow as this gets without holding a lock on the file itself, which
a shell script cannot do — the window is minimised, not closed, and saying
otherwise would overstate it.

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

**Where that flush sits turned out to matter more than the flush.** Put between
the last look and the replacement, it *reopened* the window it had been added
alongside: flushing can take seconds, and an edit arriving during it had already
been checked for and was overwritten regardless. It now runs before the last
look. A slow step belongs on the far side of a final check, never between the
check and the act — which is the general form of the mistake, and worth stating
that way, because it is easy to make again anywhere a verification precedes a
commit.

And a hard kill leaves the half-built copy behind, since no trap runs. It sits
in the release-notes directory where nothing else looks, and the `git add`
this script prints at the end would stage it for commit. Every later run now
names it — reported rather than deleted, on the same reasoning as the stale
lock: a temp file belonging to a run that is still alive is indistinguishable
from an abandoned one.

### One rule, instead of a fourth patch

Three review rounds in a row found the same fault in three different places:
the file's permissions, then its ownership, then the records saying which notes
were already filed. Each time the fix was correct and each time the next round
found the same shape next door — because the shape was never the thing being
fixed. Evidence was being read at one moment and acted on at a later one, and
patching instance three was an invitation to look for instance four.

So it is written down once and applied everywhere instead:

> Nothing irreversible happens without re-checking the evidence it rests on,
> against bytes that cannot have changed underneath the run.

This script does exactly three irreversible things — replace the dated file,
remove a note it recognises as already filed, and remove one it has just filed.
Each is now preceded by that check, through the same piece of code, so a fourth
one cannot be added without inheriting it. What "unchanged" means was widened
too, from the contents alone to the contents *and* the permissions and
ownership a replacement would silently carry over.

The notes themselves are protected a second way, because for them a check is
not enough. Each is copied once at the start, and every later read is of the
copy. The run otherwise reads a note four times — to reject one carrying a
forged record, to fingerprint it, to fold it in, to check where it ends — and a
note edited between any two of those reads makes them disagree about what it
said. The gate that matters is the first: pass it, then gain a forged record
before the fingerprint is taken, and the forgery is filed and trusted as though
this script had written it, which can have a *different* note deleted unread.
No amount of stricter validation fixes that, because the validation was never
wrong; it was reading different bytes from the ones that got used. Copying
first removes the gap rather than narrowing it.

The original is still what gets re-checked before removal — that comparison is
the whole point, and it is what keeps a note edited during the run from being
thrown away.

Auditing the same paths for the same shape turned up one more, in the recovery
route rather than in anything a review had flagged: notes recognised as already
filed were removed outright, with none of the re-checking their newly-filed
counterparts get a few lines below. A note edited since the run read it was
discarded while the dated file held only the older version. It is now kept and
named, the same as the other path.

### Stating a rule is not the same as enforcing it

The round after the rule was written down found five more places it was not
being kept — which is the useful kind of answer, because four of them were
the rule applied to only one file.

"The evidence it rests on" had been read as the dated file being written. But
the run decides what is already filed by reading *every* dated file, so a
record appearing in a different day's file after that reading leaves this run
still believing a note is unfiled: it files it a second time and deletes the
source. The same reasoning covers a dated file that appears from nowhere
mid-run, which no comparison of previously-read files can notice.

Every file the run reads is now recorded as it is read — in the same loop, so
the record and the reading cannot drift apart — and everything irreversible
checks the whole set, including whether the set itself has grown or shrunk.

Two more were about *when* the checking happens rather than what it covers.
A loop that removes several notes is several irreversible steps, not one, so
checking once before it left the second removal running on evidence gathered
before the first. And every check up to the moment the new file is put in place
asks "is this still the file the run started from" — a question that is
deliberately answered "no" afterwards. Without a fresh answer, the notes were
removed on the strength of bytes nothing had looked at since, so a dated file
disappearing during the final flush took the only other copy with it while the
run reported success.

### A note can change while it is being copied

The fifth is a different animal, and worth separating from the others. Copying
is not instantaneous: a note rewritten while the copy is being taken can yield
a copy holding the beginning of one version and the end of another — text that
never existed. Everything downstream then agrees with itself perfectly, because
they all read that same invented copy, and it is published.

Each note is now read either side of its copy and the copy compared with both.
Three readings agreeing is evidence of a quiet moment rather than proof of one,
and it is worth being precise about that: a writer could still have finished
between two of them. What it does is turn a silent corruption into a refusal
that names the file, which is the trade worth making. A shell script has no way
to make it a guarantee, and claiming otherwise would be the kind of overstated
promise this document has already had to walk back once.

### Four that were not the same fault at all

The round after that one found five more, and the useful thing about them is
that only one belonged to the class above. The rest were ordinary, unrelated
defects that a great deal of attention on one subject had walked straight past.

**A handler that could never run.** The recovery message for a failure *after*
the dated file is published — the one carefully written to explain a half-done
state — was defined further down the file than the first thing that calls it. A
shell function does not exist until its definition has been read, so the first
such failure ended with "command not found" and told the operator nothing at
all. It had been written, reviewed, and tested, and it was unreachable.

**A name this script made illegal.** Setting a note aside renamed it with a
prefix. A note name close to the filesystem's per-name limit is perfectly legal
until that prefix is added, and the rename then fails — *after* publishing —
so a first assembly always ended in the half-done state instead of finishing.

Bounding the prefixed name was tried first and produced four more rounds of the
same fault, each a different way of getting the bound wrong. That whole scheme
was then deleted in favour of a **subdirectory**: notes are set aside into
`unreleased/.assembled/` keeping their own names, so a name that was legal as a
note is legal there. The question is removed rather than answered. See the
section below for what those four rounds cost, since the lesson is worth more
than the fix.

**Another day's note aborting today's run.** Notes were copied and checked
before the day was chosen, so a note belonging to tomorrow could stop today's
assembly. That contradicts the promise made a few paragraphs above — that a run
takes its own day's notes and leaves the others in place — and it made a mixed
backlog unassemblable again, which is the exact thing choosing-not-refusing
exists to prevent. Only the check that the *ordering* cannot survive, a newline
in a name, still runs early; everything else waits until the day is settled.

**A byte this shell cannot carry.** A record with a null byte between the name
and the fingerprint is malformed, and the parser rejects it — but the shell
drops that byte before the parser ever sees it, so the record arrives looking
valid and names a different note, which is then deleted with its section
nowhere in the file. Once again the bytes that were checked were not the bytes
that were used. Such a record is now refused outright, since nothing this
script writes can contain one.

The fifth was the class: records were read from the live dated file while the
fingerprint used to detect changes came from a separate read. A record present
only for the moment of the reading, and gone before the check, left the
fingerprint matching and the index holding evidence that had never persisted.
Dated files are now copied first and read from the copy, exactly as notes are.

### Two smaller ones, and a test that proved nothing

Tidying up after all of the above found two more, both narrow.

The set-aside name introduced above was measured in *characters* while the
limit it was checked against is in *bytes*. A name of eighty-one three-byte
characters measures eighty-four and occupies two hundred and forty-six, so it
passed a bound it plainly exceeded, and the rename failed after publication
again — the fix for that fault reintroducing it by another route.

Measuring in bytes was the third attempt at that bound, and there were two
more after it: a threshold assuming one particular filesystem limit, and a
fallback that reimposed the same assumption when the real limit could not be
read. Five in total, all failing in the same place, all of them variations on
one mistake — **this script had given itself the power to turn a legal name
into an illegal one, and then tried to be careful with it.** The whole scheme
was eventually deleted for the subdirectory described above, which does not
need to be careful because it does not change the name at all. That is the
most useful thing in this document: the fix that worked was the one that
removed the capability, not the four that tried to constrain it.

And the cleanup that releases the lock runs **twice** when the run is
interrupted: once from the interrupt handler, once from the exit handler it
triggers. It did not record that it had already let go, so the second pass
released the lock again — and if another assembly had taken it in between, the
second pass released *theirs*, letting a third run overlap. Releasing a lock
you no longer hold reintroduces precisely what the lock prevents. Cleanup now
lets go once.

The test written for the first of those **passed against the broken code**, and
the reason is worth recording. It selected a locale that is not installed here;
the shell warned, fell back, and went back to counting bytes — so the two
things being distinguished became the same thing and the case could not fail.
It now picks a locale that exists, *verifies that this locale really does count
characters*, and says plainly that it skipped if none is available. A test whose
premise silently evaporates is worse than no test, because it reports a pass.

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
