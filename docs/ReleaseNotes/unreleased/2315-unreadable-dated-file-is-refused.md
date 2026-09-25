## An older dated file the assembler cannot read is now refused rather than guessed at (PR #2321)

Folding release-note fragments into a dated file has a check for one accident:
an older run that was interrupted after publishing a fragment but before
removing it. In a file written before assembly markers existed, nothing
records that, so the assembler looks for the fragment's heading and refuses to
append it a second time.

That check compared bytes, and older runs published a fragment exactly as it
was saved. A fragment saved in UTF-16 or UTF-32 therefore sat in the dated
file in a form the check could not even recognise as a heading. The first run
after such an interruption was refused anyway, because the pending copy could
not be read either. But the refusal does not say why, and the obvious remedy
is to re-save the pending copy as ordinary UTF-8 — after which the two copies
were in different encodings, the next run found no match, published a second
copy, and deleted the source. An older single-byte encoding could reach the
same end by a less likely route: its first rerun is refused as a duplicate,
with instructions that do not suggest re-saving, but an author who re-saved
anyway met the same loss. Reproduced for UTF-16 with and without a byte-order
mark and for a single-byte encoding before the fix.

The assembler now asks the question it can actually answer. If the dated file
has no markers and contains anything that is not plain UTF-8 text, the run
stops and says it cannot tell whether a pending fragment is already there,
before anything is published or removed. That refusal reads only the published
file, so re-saving a fragment does not get past it; reading the file and then
deleting the fragment, or re-running with `--force-append`, does. In a file
that already carries markers, the same condition is reported as a note, like
the other findings this check makes there.

It does not try to decode the other encoding: that would mean guessing which
parts of one file are in which encoding, with nothing to check the guess
against. Every existing dated file is plain UTF-8, so nothing that assembles
today is refused. Closes #2315.
