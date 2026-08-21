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

The recovery for both is the same and needs no judgement: run the script again.

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
mid-way. Different days do not block each other, since they touch different
files.

### Verified against the fault, not just the fix

Every new test was run against the older script first and fails there — the
interrupted-run case produces two copies of a section where one is correct, the
edited note is silently discarded, the renamed one is duplicated. Then against
the new script, where each passes. A test for a recovery path that has never been
seen failing is a test that might be checking nothing.

One of them was checking nothing, briefly, and it is worth recording. The
across-days case first "passed" against both versions — because the note it used
was still tracked by version control, so an unrelated rule held it back and the
part under test never ran. It only exercises what it claims with a note that was
never committed, and it fails on the older script now.
