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

### Why an invisible marker rather than comparing the text

The obvious alternative — skip a note whose content is already in the file —
needs a way to recognise the same text after assembly has rewritten the links
inside it. That rewriting is deliberately lossy in the direction that matters, so
matching would have been approximate, and an approximate match here fails in both
directions: skip something genuinely new, or duplicate something old. Matching on
the note's filename is exact.

The marker is matched as a whole line, so a note that merely *mentions* another
note's filename in its prose is not mistaken for one already folded in — which
would have silently dropped it instead.

### Verified against the fault, not just the fix

The new tests were run against the old script first, and they fail there: the
interrupted-run case produces two copies of the same section where one is
correct. Then against the new script, where it produces one. A test for a
crash-recovery path that was never seen failing is a test that might be checking
nothing.
