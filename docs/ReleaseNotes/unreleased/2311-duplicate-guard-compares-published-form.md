## The duplicate-heading guard now compares what assembly actually publishes (PR #2311)

Folding release-note fragments into a dated file has a safety check for one
particular accident: a file written before assembly markers existed, whose
earlier run was interrupted after the fragment was appended but before the
source was removed. Nothing in such a file can say whether a section is
already there, so the assembler looks for the fragment's heading and refuses
to append when it finds it, rather than guessing.

That check was comparing two things that were never in the same form. When a
fragment is folded in, links written from its own directory are rewritten so
they still resolve one level up — and a heading is allowed to contain a link.
A section titled with one was therefore published under a slightly different
line than the pending copy carried, the check found no match, and the run
appended a second copy and then deleted the source. That is the only outcome
in this tool that loses work rather than refusing, and it is now closed: the
fragment is converted to its published form before anything is compared.

Only the heading comparison changes. A fragment with no link in its title
behaved correctly before and behaves identically now; no fragment that was
previously accepted is now refused for any other reason.

Two accompanying notes in the source were also wrong and are corrected. One
claimed this comparison was unaffected by the link rewrite. The reasoning
behind that claim is sound where it was first made — about whether a line
counts as a heading at all, which the rewrite genuinely cannot change — and
was carried across to a different question, whether two headings match, which
it does not answer. Both places now say which question they settle.
