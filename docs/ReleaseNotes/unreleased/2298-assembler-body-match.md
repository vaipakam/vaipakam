## Thread — release-note assembler recognises an earlier copy by its text, not only its heading (PR #2346)

The assembler has a safety check for older dated release-note files that carry no assembly markers. Before adding a pending fragment, it looks for an earlier copy of that fragment in the file. If the file already seems to hold the fragment, it stops and asks the operator. Until now the only evidence was the fragment's heading line. That was the weak point. Every fix the assembler suggests when it refuses a badly formed fragment changes the start of that fragment: the heading level, the heading text, a byte-order mark, a front-matter block, or a heading added above opening prose. So an author who followed the advice after an interrupted run of an older version also moved the one thing the check compared. The next run found no match, added a second copy, and deleted the pending source. That is the only way this script loses work instead of refusing. Two cases had already been fixed one remedy at a time; this change fixes the whole class.

The check now also compares the fragment's body: everything after its first heading, or the whole text if there is no heading. The body counts only if it appears in the dated file as one unbroken run of lines. None of the remedies touch the body, so a published copy is still found after its heading has been reworded, re-levelled or re-saved. The run stops and names the fragment, and the message says whether the heading, the text or both were found.

Two limits are stated, not hidden:

- **Very short bodies don't count.** A body under 40 bytes, not counting spaces and tabs, is too short to tell a copy from a coincidence, so only the heading is compared for it.
- **Some edits can't be detected.** If a fragment's heading and body have both been rewritten since it was published, no comparison of text can tell it from a new one. Only the assembly marker can.

Before adopting the body match, it was measured against every dated file. Of 1,158 section bodies, 6 appear more than once. All six are hand-written footers from before fragments existed, so the new evidence should not stop real runs. `--force-append` remains the override.

Closes #2298.
