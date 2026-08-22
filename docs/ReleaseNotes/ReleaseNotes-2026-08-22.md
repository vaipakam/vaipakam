# Release Notes — 2026-08-22

A long day, and the entries fall into four kinds rather than a sequence — this
summary names the kinds, because an intro that counts entries or points at "the
last two" goes stale the moment another one lands, which has already happened to
this file twice.

**Corrections to what the project said about itself.** Several entries fix
documentation that had drifted from the platform: a cross-chain pause described
as standing long after it was lifted, a published payout formula that was never
right, and a user guide that told people to press a button which does nothing in
the situation it was offered for. A recurring lesson runs through them, and it is
uncomfortable: in each case the later rounds of review were spent on errors
introduced by the earlier fixes, not on the original mistake. Replacing a claim
that is too general with another claim that is too general is not progress.

**Changes to the platform.** Two contract entries, one of which changes what a
buyer can do, plus an app change that stops asking people to sign before it knows
the answer.

**Work written down rather than shipped.** A design note that re-scopes a
reward-payout safety gap without closing it, and the activation ceremony for the
recycling programme, which existed only as scattered prose until now.

**And one investigation that ended in nothing being wrong** — a reported stuck
state turned out to be unreachable. Worth publishing, since "we looked and it
cannot happen" is a result.

On the first of those corrections: a cross-chain pause on reward claims was lifted some time ago, and the
documentation went on describing it as standing — across the specification, the
design records, the test suite and the contract comments. The specification is
the document the platform's behaviour is meant to be checked against, so a reader
following it would have concluded that correct behaviour was a defect. How many
places is deliberately not stated; the entry explains why, and that reasoning
applies to this summary of it too. Most of the work went into the pause's
REPLACEMENT rather than its retraction — what stands in its place is a set of
per-day waits, and the early attempts to describe them were confidently wrong
about which deadline applies to which day, about what "compensated" means, and
about who can end a wait.

The second is the assembler that produces these files, which could duplicate
entries if it was interrupted partway.

The third corrects a published note from earlier this month that described a
payout formula that was never right — and is worth reading beside the first,
because the two share a lesson. Both were fixed more than once, and in both cases
the later rounds were spent on errors introduced by the earlier fixes rather than
on the original mistake. Replacing a claim that is too general with another claim
that is too general is not progress, and it is what happened here twice before it
was noticed.

After those, a design note re-scopes a reward-payout safety gap: the part that
looked closed turns out to be evadable, so what remains is differently shaped
rather than smaller. It is worth reading for what it decided NOT to do.

The two contract entries close the day. The first makes the accept path
changeable again: it had reached its size limit, and splitting it was a
prerequisite rather than an improvement in itself. The second is the only entry
here that a user can notice — a sale listing that no longer describes the
position it sells is now refused at purchase instead of completing, and the
reason given is the one that can actually be acted on.

## The documentation caught up with a pause that had already been lifted (#1222)

Reward claims on chains other than the canonical one used to stop entirely for
days after the cross-chain cutover. That pause was deliberate: such a chain's
reward funding arrives from the canonical chain, and until the platform could
bound a payout by what had actually been received, resuming would have let a
chain pay out of tokens held for unrelated obligations. An attempt to lift it was
made and withdrawn in review when two further problems came to light — separate
from the original cause, and from each other: the scheduled side had no limit
against what a chain had actually received, and days deliberately recorded as
zero would have retired themselves before their compensation could arrive.

**Both were subsequently solved — by different pieces of work — and the pause
was lifted.** A chain now prices
those days from its own record of what it was funded, and a day it is not yet
ready to price **waits** rather than stopping the chain: a day short of funding
waits for the funding, and the other waits end when whatever each is missing
arrives. What remains are per-day waits. They still hold a chain up while they
last — days are settled oldest-first, so a day that waits blocks every later one
for everybody on that chain — and they are not all short: a day whose funding
record never arrives waits indefinitely unless someone re-sends it, which anyone
can do — at the cost of delivery only, not of the funding — whenever the record
was already settled centrally and only its delivery failed. What changed is that each wait is now
attached to a specific missing input, which can be seen, chased and supplied,
and that one case — a day deliberately recorded as zero and awaiting
compensation — also carries a deadline after which it can be settled by anyone.
There are two such deadlines, not one, and they are not interchangeable: a day
that never drew compensation is closed out on a clock fixed at the day's
freezing, while a day compensated below what it owed is closed out on a separate
clock that starts when its compensation is SETTLED — at arrival where the
record was already there to settle it, at settlement time where the money
overtook the record, and, for compensations settled before this clock existed,
at the moment anyone first starts it — and stretches with each qualifying
top-up. Passing the
first deadline does not open the second. And a compensation still sitting
unsettled opens NEITHER, nor has its clock begun: that day's way out is the
record being re-sent, which anyone can do. Re-sending settles the figure — it
does not necessarily uphold it. Where the record agrees with what was paid the
figure stands; where it does not, the credit is set aside instead, and that
money is destined for return rather than for this day's rewards. The stop
they replaced had neither: nothing to supply, and no ending. A day waits until everything it needs is in place, and
the things it can be waiting for are given as examples rather than as a complete
set — deliberately, because every earlier attempt to close that list was
overtaken. A day can be waiting because its funding record has not landed,
because the budget delivered does not yet cover it, because it was recorded as
zero and its compensation has not arrived, because that compensation is present
in full while the figure behind it is still open to revision, or because the
chain's own settlement has not yet walked forward to that day — it catches up in
bounded steps, so a chain far enough behind needs more than one attempt. The last
two wait with the money already there, which is exactly why funding alone was
never the test.

**The documentation did not follow.** Dozens of separate places across a dozen files
still told the reader the pause was in force and that the attempt to lift it had
been withdrawn — including the functional specification, which is the reference
for what the platform is *intended* to do and is therefore the document an audit
would judge the code against. Someone reading it would have concluded that
correct behaviour was a defect. Several stale statements sat in the same passage
as the correction, contradicting themselves a few lines apart; one was a section
heading directly above a test that proves the opposite, and another was a status
table still reporting the work as abandoned.

**Corrected as a class, not as a list.** The statements were found by searching
for the *claim* in every phrasing it takes, rather than by fixing the places
someone had happened to notice, and the search was repeated after every pass —
which is what found them: the first sweep located five, and every pass after it
raised the number again — including the last one. A precise total is not given
here on purpose. Every version of this paragraph that carried one was overtaken
within a round, and a stale count reads as a completeness claim, which is the
thing this change is least able to make.

**Two nearby statements were deliberately left standing**, because correcting
them would have introduced errors of the opposite kind. A
dated release note from the period is a historical record of what was true when
written. And an unrelated deployment pause merely shares the vocabulary.

**A correction introduced by this change, and caught in its own review.** The
first version of this note said the only remaining wait was a day whose funding
record had not landed. That was a new inaccuracy of exactly the kind the change
set out to remove — a stamped day that was deliberately zeroed also waits, and
saying otherwise would have understated when a reader should expect rewards to
pause. Many stale statements were corrected here; introducing one more
while doing it is the failure mode worth naming rather than quietly fixing.

**The specification change is a recorded decision, not a transcription.** These
documents are written from the project's stated intent and never copied from the
code — a rule that exists so the specification can still catch a bug rather than
merely restating one. The intent here was settled and shipped when the lift was
merged; what had been skipped was the specification edit that should have
accompanied it. This closes that gap and does not decide anything new.

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

Two states still need a person first, and both are deliberate.

The first is a note **set aside mid-run** — moved out of the pending pile but not
yet removed when the run stopped. Any interruption does this, not only a hard
kill. It is reported rather than acted on, because nothing says whether it is the
copy already folded in or a newer edit, and cleanup does not move it back: the
original path may by then hold something newly saved, and restoring the older
copy over it would destroy the very text this mechanism protects.

The second is a **stale lock**. Assembly holds one so two runs cannot overlap,
released whenever the script exits, including on Ctrl-C. A hard kill leaves it
behind because no handler runs at all — and so does anything that stops the
release itself from working, such as the directory turning read-only mid-run.
Either way later runs stop until it is cleared. That is deliberate: the lock
guards a step that deletes files, so a stale one is reported — with the exact
command to remove it, where the run was alive enough to say so — rather than
broken automatically on a guess about whether the other run is still going.

In both cases the run says what it found and what to check.

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

### Three fixes that each stopped one step short

The last round found nothing new in the design. It found three places where a
fix already made had been applied to almost the whole of what it covers.

The gate before publication re-asks everything about the set-aside directory
that was settled at startup, because startup only answers for startup — is it
still a directory, can entries still be created and removed in it. It asks two
of the three questions. The third, *is it still on the same disk as the notes*,
was left at startup, and it is the one whose failure is worst: a disk mounted
there part-way through turns setting a note aside from an instant rename into a
copy followed by a delete, which is exactly the loss that mechanism exists to
prevent. The two properties that were re-checked and the one that was not are
the same directory, in the same gate, for the same reason.

The second is smaller to describe and harder to have noticed. Everything the run
does before it swaps the finished file into place is covered by a catch-all that
reports what happened if any step fails. It was switched off one line early — so
the swap itself, the single act the whole script exists to perform, was the only
unguarded step in it. A failure there exited with the operating system's one-line
complaint and nothing about the notes, which are all still safely pending and
precisely what the operator needs to be told. The comment above that line said it
was switched off *after* the swap. The comment was describing the right design.

The third produced a message that contradicted itself. The steps that run after
the file is published kept their own list of what they had cleared, while the
report they end by printing reads the lists that everything *before* publication
maintains. So a failure at that point named the notes already folded in and then,
three lines later, announced that nothing had been consumed and no note had been
touched — in one message, about the only question being asked. The fix is not a
better-worded report; it is having one list instead of two. Two records of the
same fact disagree eventually, and the second one is always the one nobody
remembers to update.

### The last check on the finished file was made after replacing it

The step before publication had grown into a careful list: is the finished file
still an ordinary file, does it still carry the permissions this run chose, does
it still belong to the right group. It did not ask whether it still says what
the run wrote — and that is the thing the other three exist to protect.

The content *was* compared, against a fingerprint taken before the disk flush,
one step after the swap. Which is the one place the comparison cannot help: the
previous day's notes have been overwritten by then, so the run's careful refusal
arrives having already destroyed the thing it was refusing to destroy. Asked a
moment earlier it costs one fingerprint and the earlier file is untouched.

Both comparisons are kept, because they answer different questions — whether
the file about to be installed is the one this run built, and whether the swap
put those bytes where they were meant to go.

### Sorting the notes could lose one, quietly

The step that puts the notes in order read its result in a way that cannot tell
whether the ordering worked. If the sort printed one of two names and then
failed — a locale it cannot load, a disk that filled — the shorter list was
taken for the whole pool. One note was folded in, the other was neither folded
in nor removed, and the run finished by printing the usual "here is how to
commit this" without a word about the one it had dropped.

Both halves are now checked, and they catch different things: whether the sort
failed, and whether the number of notes coming out matches the number that went
in. Ordering rearranges a pile, it does not shrink one, so a different count is
wrong whatever the exit code claimed.

Doing less than asked and reporting success is the specific failure this whole
piece of work exists to make impossible, so having it sitting in the ordering
step was worth the round it took to find.

### A green test run that was not measuring thirteen of its own cases

This one was not found by review. It was found by reading the automated checks
after a push, which is a thing I had not been doing for this suite because the
check is marked non-blocking — and "non-blocking" had quietly become "not my
problem", while what it was actually running was these tests.

Thirteen cases stage their fault by taking a permission away: a note that cannot
be read, a directory that cannot be written to, a file belonging to somebody
else. The account doing the work here has no permissions to take away, so those
cases cannot be set up and they stood down — printing a cheerful line that
looked exactly like a pass. A full run reported every case passing. Two of the
thirteen had been **failing** for at least three rounds, in the only place they
ever ran.

Neither failure was a real defect. Both were assertions pinned to the exact
wording of a message that had since changed — one of them changed *because* an
earlier round added a stricter check that now refuses sooner, correctly, in
different words. Which is the point: the tests were right to be checking, and
nobody was reading the answer.

Three things changed. The two assertions now check what the case is about —
that an unreadable file is refused rather than read as having no records, that
an unwritable directory is refused *before* anything is published — instead of
quoting a sentence that any later improvement will move. A stood-down case now
says **SKIP**, is counted, and the count is stated at the end, because a skip
printed as a pass is how this lasted. And a run that holds every permission now
does the work **twice**: once as itself, then again as an ordinary account, so
the cases it cannot stage are staged after all and their result is part of the
verdict rather than something only a distant machine ever sees.

The second half of that matters as much as the first. Some cases need the
permissions and some need the lack of them, and no single run covers both — so
dropping privileges outright would have cured this blindness by creating the
mirror image of it.

### What this is protecting against, and what it is not

Worth saying plainly, because it is the difference between a long list of fixes
and a coherent one.

All of the above is about **an ordinary environment behaving awkwardly**: a run
interrupted partway, an editor saving a note at the wrong moment, a second
assembly started by mistake, a filesystem refusing something, a filename or a
byte the shell mishandles. Those happen by accident, routinely, and each one of
them costs text — which is why a script that folds five files together has this
much care in it.

It is **not** protecting against somebody hostile who can already write to the
release-notes directory. Not because those attacks are imaginary, but because
anyone with that access can delete the notes, rewrite the published file, or
edit the assembler itself, none of which involves racing anything. Hardening
against the most awkward of their options while the direct ones stay open buys
the appearance of safety and not the thing.

One concrete consequence is recorded rather than quietly left: the lock is a
directory, and someone with write access to the pool can remove it and start a
second run. That is a genuine property of this kind of lock, it cannot be fixed
in a shell without a primitive the shell does not have, and it is out of scope
for the reason above rather than by oversight.

Where a defence costs nothing it is taken anyway — the replacement is built in a
private directory, and no permission change is applied to a path another party
could substitute. The line is drawn at contorting the design for an adversary
who does not need to beat it.

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
<!-- assembled-fragment: 1788-assemble-crash-safety.md sha256=407c6e86b259c05beda1048a9bb35a5f52f74b72544b4544c0d70af34f3e5da8 -->

## A published note carried a payout formula that was never right (#1879)

A release note from earlier this month described how a compensated-but-
underfunded reward day pays out when its deadline passes, and said that
every settlement path pays proportionally within the funding that
arrived. That is not what the platform does. A per-entry allowance comes
off the funded pool before the proportion is worked out, so a side whose
funding does not clear that allowance pays nothing at all — even though
funding did arrive. And it is settled per side rather than per day: the
lender and borrower halves each have their own pool and their own
allowance, so one of them can pay nothing while the other pays in full.

Dated release notes are normally left as they were written, on the
grounds that they record what was believed at the time. That rule does
not cover this one. The allowance was already in the platform six days
before the note was written, so the paragraph was not true-then-stale; it
was wrong when it was published.

The difference matters because of who it costs. A stale status claim
leaves a reader with an out-of-date picture of where things stand. A
wrong formula hands them a number, and anyone sizing an expected payout
from that paragraph would have arrived at one the platform will not pay.

The published wording is left where it is, with a marker pointing at a
correction appended to the same file. A reader who finds the old
paragraph is told it was corrected, and a reader who reads to the end is
told what the correction says — neither is quietly rewritten out of what
was actually published.
<!-- assembled-fragment: 1879-short-lapse-formula-correction.md sha256=24f65ee99363b82cc76922bf0e752fe03b01d253aa8fd12a526415d9033b4032 -->

## A reward-payout safety gap was re-scoped, not reduced (#1566)

A known fund-safety issue has been open since early August: a reward payout is
limited by whatever spare balance the platform happens to be holding, rather
than by the money actually set aside for rewards. That spare balance is not
spare — it also holds two kinds of user collateral, so a reward payout can in
principle be paid out of a borrower's collateral.

Re-reading that issue against the platform as it stands today changed the
picture — but it moved the boundary rather than shrinking the gap. Separate work
two days earlier looked like it had limited part of it: on a chain that RECEIVES
its reward funding, a payout for a day inside the new programme is limited to
what actually arrived. That limit holds only where such a day is the only thing
being claimed, and the note's own conclusion is that what remains is DIFFERENT in
shape, not smaller. What is open: the chain rewards originate on, where nothing
arrives and so the limit has to be defined rather than copied across; older
entitlements on the receiving chains, which are paid by a route the new limit
never sees and never records, so a single person holding both kinds can spend
twice against one balance — which is what makes the limit evadable rather than
merely partial; and a chain that has been detached from the group, which ends up
limited by nothing at all because it is no longer recognised as either kind.

That distinction is now written down, along with why the obvious repair — keep a
list of everything else the balance is holding and subtract it — is the one
approach with evidence against it here. The list grew in every review round it
was declared finished, two of its members are invisible to that repair by
construction, and an attempt at it was reverted for creating a fresh way to lose
user value: it left expiry clocks running on entitlements whose claims had begun
to fail.

Five options are set out with what each promises a claimant, but only four are
candidates: the first is kept on the page as an analysed-and-rejected step,
because it cannot deliver the property the card asks for, and putting it back on
the menu would offer the owner something that does not close the issue. The
four-way choice is left to the owner rather than made in passing. Some of them
keep the money in one shared pot and differ only in how carefully they reason
about who owns what. Two do something else: one keeps the reward money somewhere
separate, and one does not hold it at all until the moment someone claims it —
in both, the question of who owns a given token stops arising rather than being
answered more carefully.
The second of those is narrower than it sounds and the note says so: it applies
to freshly created reward value only, and leaves the recycled half — which is
already held — still to be answered.

Both of those arrived from review rather than from the drafting, and for the same
reason: the search had been for a better way to COUNT a shared pot, so anything
that changed the arrangement instead was outside the frame being searched. For a
document whose whole job is to lay out the choices, that is the failure worth
recording. A first draft of this note did
recommend one of the shared-pot approaches as a cheap first step; review
established that it does not actually set any money aside — it limits what a day may price, which is a
different question — so the recommendation was withdrawn rather than softened.
A note on a fund-safety question whose recommended step leaves the property
unmet is worse than one that recommends nothing. The reward programme stays
un-armed until this closes, which is unchanged and deliberate.
<!-- assembled-fragment: 1566-canonical-delivered-bound-design.md sha256=d96a330397d52db1a6ffa75356c0ef557bce598fec043f0802b28b73b6c14ee1 -->

## Contracts — the accept path can be changed again (#1888)

`OfferAcceptFacet` had reached 24,412 bytes against the 24,576-byte on-chain
limit. The 164 bytes left were less than one cross-facet call costs, so the
accept path had stopped being editable: any change to it — including the
pre-mirroring sale-listing refusal this unblocks — compiled fine and then
could not be deployed. This is the same wall `EarlyWithdrawalFacet` hit at 30
bytes, and the fix is the same shape: move a piece of the work to its own
facet rather than trim behaviour to fit.

The piece that moved is the borrower's Loan Initiation Fee charge and the
delivery of the net principal — the fee-and-disbursement step of an acceptance.
(Not its last money movement: the borrower's collateral is locked afterwards,
and a Full-tariff acceptance moves VPFI later still.) It was chosen because the
acceptance **already** ran it in a separate execution
context: the accept had long reached it through an internal self-call, so that
the fee work's own depth would not be charged to the accept's call frame.
Moving it means the step now lives at a different address on the far side of a
boundary the code was already crossing. That boundary is reached on a fresh
cash-loan acceptance and only there: a purchase of an existing position skips
the fee entirely, because the position paid it when it was first created, and an
NFT rental takes its own path. Nothing about the observable sequence changes on
the accepts that do reach it — same order, same shared state, same single
transaction, and a failure anywhere past the boundary still unwinds the whole
acceptance. Callers see no difference at all: they still send one transaction
to the one platform address, and the function's on-chain identity is unchanged
by the move.

Deployment shape is what changed. The platform now installs one more facet, so
every place that enumerates facets — the deploy script and the two refresh
scripts, the deploy-time guardrails, and the deployment record consumers read
— names it. The two halves must always be installed and refreshed **together**:
they are one behaviour separated by a call, so a partial refresh would leave an
acceptance running new code on one side of that call and old code on the
other. The refresh scripts carry both for exactly that reason, and the one
curated script that reinstalls the accept path re-points the moved step onto
its new host, so a platform upgraded from before this change does not strand it
on the old one.

Resulting sizes: 21,071 bytes for the accept facet (3,505 free, up from 164)
and 4,390 for the new one. `OfferAcceptFeeFacet.chargeBorrowerLifAndDeliver` —
the new home; the old facet no longer contains it — is
not a surface any app called — it rejects every caller except the platform
itself — so no application-facing behaviour is affected.

Closes #1835's blocking prerequisite; the refusal itself follows in its own
change.
<!-- assembled-fragment: 1835-offer-accept-facet-split.md sha256=acb7c81a0c9b8287730a17108901780449a908dc6ab238e899c222c8def51688 -->

## Buying a position: an out-of-date listing is now refused instead of sold

A position put up for sale is advertised through a listing that states what the
position permits — whether the borrower may repay it in instalments, whether
they may raise money against it by listing a prepayment, which interest model
the loan runs under, and whether interest falls due periodically. Those four
things decide what the borrower can do to whoever buys the position, and how
that buyer is paid, so a buyer chooses on them.

Listings created from a recent change onwards copy those terms off the live
position, so they describe it accurately. Listings created **before** that
change carried only the interest model, which had been copied for some time
already; the other three took their blank defaults, so such a listing says the
borrower may do none of those things while the position itself may permit all of
them. (A listing older still, from before the interest model was copied either,
can be wrong about all four — which is why the check compares all four rather
than the three that the most recent gap left behind.) Nothing caught this, and the reason is worth stating plainly.
When a buyer commits, the platform checks that what the buyer signed matches
what the listing said — and on an out-of-date listing those two agree
perfectly. The buyer read the listing, signed exactly what it advertised, and
every application shows the same thing. The mismatch is not between the buyer
and the listing; it is between the listing and the position, and nothing was
comparing those two.

That comparison now happens at the moment of purchase. If a listing's terms
disagree with the position it sells, the purchase is refused before any of the
buyer's money moves, and the refusal says what it actually is: the listing is
out of date and the seller needs to relist. That wording matters — the buyer did
nothing wrong, so telling them their terms don't match would send them to sign
the same wrong listing again. Relisting produces a correct listing, because
listings have described their positions accurately since the earlier change.

One thing about that refusal took most of the work to get right: it is only
ever the answer when nothing else is. "The listing is out of date, ask the
seller to relist" is useful advice, but only where relisting is actually
possible — and often it isn't. A position that has already been repaid,
defaulted or liquidated cannot be relisted at all. Neither can one that has
passed its due date, or one whose seller has since been placed under
sanctions, or one holding an asset the platform has paused — and while the
platform as a whole is paused, nothing can be listed or bought at all. In each
of those cases the platform has a reason that the person reading it can act on
(even if only by waiting), and answering "relist" instead would have buried it
behind advice that cannot be followed. So the out-of-date refusal now speaks
last among the reasons the platform checks before it starts moving money, and
the buyer sees the reason that is worth seeing. (A purchase can still fail after
that point for the ordinary reasons any transaction can — a transfer that does
not go through, a position that no longer clears its safety margin — but those
are failures rather than reasons the listing itself was refused.) The preview shown on the card and the refusal from the transaction
itself agree on which one that is. That agreement is a property of the platform,
not yet of any screen: no app currently reads the preview's verdict, so a card
can still offer a purchase that the transaction then refuses. Wiring the verdict
into the card is tracked separately (#1645); what shipped here is the preview
being correct and consistent for whoever reads it next.

There is one deliberate exception, and it follows the same reasoning rather than
breaking it. If the person trying to buy is the **borrower of the very loan
being sold**, they are told the listing is out of date first, even though they
also could not buy it for that separate reason. That is because relisting does
genuinely help here — the seller can put up a correct listing, and everyone
except that one person can buy it. Everywhere else the refusal is ordered last
precisely because relisting would not help; here it would, so it is worth
saying. Someone who is simply trying to buy back **their own listing** is told
that directly, since no relisting changes it.

Sellers and buyers on current listings notice nothing: an accurate listing
satisfies the check by construction, and a normal purchase is unaffected.

This closes a gap that had been recorded but left open, because the change
needed room the accept path did not have until the facet carrying it was split
in the preceding release. As shipped the check costs 448 bytes, and the facet it
lives in now stands 3,057 bytes below the size limit. Before the split there
were 164 bytes free — not enough for even the smaller prototype this grew from,
and nothing at all for whatever came next.
<!-- assembled-fragment: 1835-stale-sale-listing-refusal.md sha256=86fe3b957a86ec592a4a332826ae344dbb24a9cb19f448f32a21e785a6cf085e -->

## The recycling activation ceremony is written down (#1349 M7)

Turning on the cross-chain VPFI recycling loop is a one-time sequence that spans
every chain, and until now it existed only as prose scattered across a planning
document. It is now a section of the governance runbook, in the order it has to
be performed, with the reasons each step comes where it does.

Three of those reasons are the kind that are only obvious in hindsight. The fee
entitlement has to be switched on **first**, because any loan opened between a
clean scan and that switch rejoins the class the scan was checking for — so
scanning first and enabling second means the scan result can be overtaken by
ordinary business. There is no way to fix such a loan afterwards: the stamp is
written when the loan opens and nothing can add it later, so the only remedies
are the ordering above and waiting for the loan to close. And where the platform is running
across several chains, the arming call is a single transaction on one chain that
commits all of them — it cannot be repeated, cannot be undone, and cannot be
postponed once the day it names arrives. (On the simpler arrangement where only
the main chain pays rewards, that call commits only that chain and nothing has to
be told; the runbook now separates the two, because a step that cannot be
completed on the simpler arrangement was previously demanded of it.) — so the day chosen has to leave room for every other chain to hear
about it, and each one has to be checked before that day, not after.

**A gate that reads as closed is not.** The plan pointed at a card for the
fund-safety half of the backing separation — reward payouts being bounded by the
platform's spare balance rather than by what was actually delivered for rewards,
where some of that balance is borrower collateral. That card shows as completed.
It was closed automatically when a different, smaller piece of work merged
mentioning it, and the real remaining half was re-filed under a new number. The
runbook, the plan and the library comments now all name the open card, and say
why the closed one is not evidence. Anyone verifying this gate by opening the
card the documents used to name would have read a green label over an open
fund-safety defect.

**Review then found three ways the first draft would have stranded an
operator mid-ceremony**, all of them about order rather than fact. Every piece
of keeper preparation now comes before the irreversible step, because none of it
can be redone afterwards — the day being switched on cannot be moved once it is
named. One authorization was missing outright: the address that sends funding
from the main chain has to be approved for that specifically, and the approvals
covering the other chains do not include it, so an operator following the first
draft would have finished the ceremony and then watched every funding send be
refused. And the day chosen has to be counted from when the switch-on actually
happens, not from when it is requested — on a live deployment those are two days
apart by design, which was enough to consume the whole safety margin the step
exists to provide.

Nothing about how the platform behaves changed here.
<!-- assembled-fragment: 1349-governance-runbook-recycling.md sha256=68a0f5f7186fee423d1e104d06c6ab49f4f31ebef1715a017ead242c2473cf34 -->

## The app now asks before it makes you sign (#1645)

Before this, the connected app could walk someone into a transaction the
protocol had already decided to refuse. The platform has carried a preview for
some time that answers, without charging anything, whether an offer can be
taken right now and — if not — which reason applies. No screen read that
answer. The one place that called the preview took the fee estimate out of it
and discarded the verdict, so the only way a buyer learned about a blocker was
a rejected transaction they had signed and paid for.

The accept flow now consults that verdict and stops there, before the wallet
prompt rather than after it. The reason it shows is the protocol's own, in
plain words: the offer expired, the listing is out of date and the seller needs
to relist, one of the assets is paused, the vault on one side needs upgrading,
the protocol itself is paused. All twenty reasons the platform can give are
covered, not only the out-of-date-listing one whose arrival made this visible.

Three details are worth stating because they are the difference between a check
that helps and one that misleads:

**It reports the first refusal, not a refusal.** The preview applies its checks
in the same order the transaction does, so whatever it names is what the buyer
would actually have hit first. That ordering is the point of the whole
mechanism, and the app deliberately does not re-rank, filter, or improve on it.

**A reason it does not recognise stops the transaction.** The app can be older
than the platform it is talking to, and this vocabulary grows over time. An
unrecognised answer is a refusal nobody has written words for yet — never an
all-clear — so it blocks with a general message rather than waving the buyer
through into the revert this exists to prevent.

**It does not quote a number it never measured.** One refusal concerns a
position that has fallen below the safety margin its sale required. The obvious
thing to show is the shortfall, and the preview does not carry one — so the
message states the condition without a figure. An earlier round of this work on
the platform side established that showing a health figure for a position that
was never measured is worse than showing none.

Two limits are deliberate and worth knowing. The signed-order fill path is
untouched: a signed order has no offer to preview until it materialises, so
this check cannot apply there and the separate protections that path already
has remain what covers it. And on the current testnet deployment the four
newest reasons will not appear until the preview component is refreshed —
before that refresh, a review can honestly confirm only the older reasons and
the clear path.

Closes #1645.
<!-- assembled-fragment: 1645-accept-preview-gate.md sha256=13a347cbcec744acdcd466d7b3be12f1716cd8b7bf7fa38fb5bd324758b0567c -->

## A reported stuck-listing state turned out to be unreachable (#1851)

A review of an unrelated design document raised a worrying pairing in the
position-sale code: a listing that has been taken but not yet finished cannot
be finished once the underlying loan ends, and the permissionless cleanup that
clears dangling listings deliberately skips listings that have been taken. Put
together, those two rules would leave a listing that could neither complete nor
be cleared.

Both rules are real. The question nobody had asked was whether anything can
actually put a listing into that state, and the answer is no — a state with no
way out only matters if there is a way in.

Taking a listing finishes the sale in the same transaction, and a finish that
cannot succeed undoes the whole purchase, so "taken" and "finished" are set
together or not at all. The one route that could mark a listing taken without
that step is the partial-fill matcher, and a position sale cannot be matched at
all — it is an all-or-nothing transfer that only direct acceptance can take. And
if the loan behind a listing has already ended, the purchase is refused outright,
before any of the buyer's money moves, leaving the listing untaken and the
cleanup available.

Nothing about how the platform behaves changes here. What changes is that the
reasoning is now written down where it is needed and enforced by a test: the
cleanup's own code carries the explanation of why skipping taken listings is
safe, and a test drives the exact scenario that was reported — list a position,
let its loan end, attempt the purchase — and checks both halves of the claim,
that the purchase is refused *and* that the listing stays clearable afterwards.

The intended behaviour was already recorded correctly in the platform
specification, which states that no buyer can be harmed by a dangling listing
because a purchase against an ended loan is already refused. That is worth
noting: the specification is written from the design documents rather than read
back off the code, so it stood as an independent statement of the same property
the code turns out to have.

Closes #1851.
<!-- assembled-fragment: 1851-sale-listing-reachability.md sha256=e36029d7b1c04575a698d78f87fbe45a1605e803ae2d8d9dc5b534152113b290 -->

## The guide told users to press a button that does nothing in the state it was offered for (#1881)

The Advanced guide explained that a discount cached on another chain goes stale
after a couple of months, and that it comes back "until a fresh push lands" —
read alongside the two places the same guide offers a button to push your tier to
other chains, that reads as an instruction: your discount lapsed, press this.

Pressing it does nothing in exactly that situation. The push only sends when
something about your tier has actually changed; an unchanged tier is skipped
silently, nothing is broadcast, and the reader is left where they started while
believing they have fixed it.

The passage now says so directly: an expired cache on a tier that has not moved
is not something the button fixes, and restoring it takes two separate things.
Your standing with the protocol has to differ from whatever you last sent
ANYWHERE — the check is one per person, not one per chain, so a chain that was
added later or that missed a delivery will not get a replacement copy just
because it is behind — and it has to still be good enough to earn a discount, since dropping below the
lowest band or switching the discount off is a difference that gets sent
faithfully and leaves you no better off. And then something has to actually send
it: changing your standing does not broadcast anything on its own, so a push is
still required to carry it. Note that a governance change to the tier table
counts as a difference even when nothing about you has moved.

It also says plainly that there is no supported way to force a refresh
otherwise, and why: manufacturing broadcasts by toggling a value back and forth
drains a protocol-funded budget, and once that runs out legitimate broadcasts
fail for everyone. A workaround that is harmless once and harmful at scale does
not belong on a page anyone can read.

The button's other two uses — a newly activated tier, and crossing into a higher
one — are correct and unchanged. Only the stale-cache case was wrong.
<!-- assembled-fragment: 1881-stale-cache-push-instruction.md sha256=71c2965652a69f6b2d3d3ce7de99ae7e3de8a6d9fd1fa5b52cd08dea74cd3bd2 -->
