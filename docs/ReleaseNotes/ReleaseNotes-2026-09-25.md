# Release Notes — 2026-09-25

Three changes to how these notes are produced, and none to anything the
platform does. All three close ways the assembler could publish a fragment
twice or misreport what it had done, and each was found by reading the code
and reproduced in a test rather than observed in the published notes. They
are listed in the order they merged, because the third builds on the first.

Five other merges landed the same day and are not written up below, because
none changes behaviour. PR #2319 published the previous day's notes. PR #2324
changed heading levels, and nothing else, in ten earlier dated files: 32
sections had opened at the level of a document title and now open as sections
of their release, with five of them moved down whole so their own subsections
stayed subsections. PRs #2325, #2326 and #2327 reorganised the assembler's own
documentation so that each rule is explained in one place rather than several.

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
deleting the fragment, or re-running with `--force-append`, does. (As merged,
a file that already carried markers only reported the condition as a note;
later the same day #2328 narrowed that — see the last section below.)

It does not try to decode the other encoding: that would mean guessing which
parts of one file are in which encoding, with nothing to check the guess
against. Every existing dated file is plain UTF-8, so nothing that assembles
today is refused. Closes #2315.
<!-- assembled-fragment: 2315-unreadable-dated-file-is-refused.md sha256=80ef520b4e7cb0875dcc5800f4c6c575549ead7546c555590a65e9cd70dfac93 -->

## Text quoted back from a fragment can no longer rewrite the assembler's messages (PR #2323)

When the release-note assembler refuses a fragment, it quotes the offending
line and names the file, so the author can find what to fix. Nothing filtered
what it quoted. A terminal acts on control sequences rather than printing
them, so a fragment whose opening line carried the right few bytes could
erase the refusal on screen and print a success message over it. The run
itself still refused — nothing was published and nothing was deleted — but
the operator's view of what happened could be forged, which is the one thing
a tool built to refuse clearly must not allow.

Every message now passes through one point that shows each control character
as a visible escape such as `\x1b`, instead of letting the terminal act on
it. That covers file names as well as quoted lines, and any message added
later. The characters are shown rather than removed, because a stray control
character in a file name is something the operator needs to see in order to
find the file. The invisible characters that reverse the direction of text
are treated the same way, since they can reorder a line on screen without
any control sequence. Ordinary text, including the em dash every heading
here uses, is printed as before.

Anything quoted from a fragment — a line, or a list of the references it
refused — is also cut off after 160 characters as a whole, with a note of how
much was left out, so a long line or reference list cannot bury the message
around it. Closes #2302.
<!-- assembled-fragment: 2302-quoted-text-cannot-forge-output.md sha256=fd5770af2701dc1710457f9bac6f0c2eb26dd86c8836cb7e5438a92179167845 -->

## An older release-notes file that has gained one marker no longer loses a fragment on rerun (PR #2328)

Folding a release-note fragment into its dated file leaves a small invisible
marker behind, which is how a later run recognises a fragment it has already
published. Files written before markers existed have none, so for them the
assembler falls back to a weaker check: if the file already contains the
fragment's heading, it stops and asks rather than appending a second copy.

That check looked at whether the file had any marker anywhere. A file written
wholly after markers existed is fine under that rule, but most dated files are
older, and each gains its first marker the next time anything is folded into
it. From then on, one marker at the bottom switched the check off for every
older section above it: a fragment matching one of those was published a
second time and its source deleted. This was found by reading the code and
reproduced in a test; no duplicate has been traced to it.

The check now asks the question per fragment: does this file record a marker
for this fragment's own name? If it does, the pending text is either an edit
made after an interrupted run or a new fragment reusing an old file name;
neither loses anything by being appended, so it is appended with a note as
before, asking for a superseded copy to be checked. If it does not, the run
stops and asks, whatever other markers the file carries. The same rule now
governs the refusal for a dated file that cannot be read as plain text, and
that check no longer counts the markers themselves: a marker records a
fragment's file name exactly as the filesystem gave it, which need not be
plain text, and one such name used to make a whole file look unreadable.

The cost is a refusal when two different fragments in one day's file share a
title exactly. In every dated file in the repository, the only repeated
headings are subsections such as "Verification" — no two fragments share a
title — and `--force-append` remains the override once the file has been
checked.
<!-- assembled-fragment: 2312-marker-coverage-per-fragment.md sha256=1f8c4cf7837e9d417c0b1a76e09928cde2da2583aec76c5fd7ad97c7c2dba7e0 -->
