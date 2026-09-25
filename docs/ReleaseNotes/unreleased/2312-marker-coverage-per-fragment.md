## An older release-notes file that has gained one marker no longer loses a fragment on rerun (PR #NNNN)

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
