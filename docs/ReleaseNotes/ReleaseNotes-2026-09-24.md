# Release Notes — 2026-09-24

One behaviour-changing merge, again to how these notes are produced rather
than to anything the platform does. It closes one way the assembler could
publish a section twice and delete its source, and says plainly that a second
way remains open. PR #2310 also landed the same day and is not written up
below: it revised three design documents and changed no behaviour.

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
appended a second copy and then deleted the source — publishing a duplicate
and losing the original rather than refusing. That path is now closed: the
fragment is converted to its published form before anything is compared.

It is not the only such path, and this change does not claim to be. If an
interrupted older run already published a fragment saved in an encoding that
writes its heading differently from UTF-8 — UTF-16, or an older single-byte
encoding once the heading has any non-ASCII character, such as the em dash
nearly every heading here carries — the next run refuses it. The refusal does
not tell the author to re-save the file, but re-saving it as UTF-8 is the
obvious response — and on the run after that, the check still cannot see the
earlier copy, and the same duplicate-and-delete follows. No such fragment is
pending today; the case is open and tracked as #2315.

Only the heading comparison changes. A fragment with no link in its title
behaved correctly before and behaves identically now; no fragment that was
previously accepted is now refused for any other reason.

Two accompanying notes in the source were also wrong and are corrected. One
claimed this comparison was unaffected by the link rewrite. The reasoning
behind that claim is sound where it was first made — about whether a line
counts as a heading at all, which the rewrite genuinely cannot change — and
was carried across to a different question, whether two headings match, which
it does not answer. Both places now say which question they settle.
<!-- assembled-fragment: 2311-duplicate-guard-compares-published-form.md sha256=cbebe20a74ba3a5637f3e1e5fa16ea3151f4a045ab4c4927e38bf37f1c338cf6 -->
