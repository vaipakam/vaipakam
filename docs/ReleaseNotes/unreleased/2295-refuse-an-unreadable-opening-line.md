## Thread — A fragment the assembler cannot read is now refused, not published (PR #2301)

Release notes are built by folding one file per change into a dated
document, and the only part of such a file that has to fit a shape is its
opening heading. Until now, when the assembler could not recognise a heading
on that line it took the permissive route: it published the file anyway and
deleted the original. So the outcome of *not being understood* was the same
as the outcome of being correct — except that what arrived in the released
notes was whatever the author had actually written, rendered as something
nobody intended, with the source gone.

Eleven different malformed shapes were shown to slip through that way, one
per review round: a title underlined instead of prefixed, a heading indented
a little too far, a file saved with an invisible byte-order mark, a heading
written inside a quotation or a list. Each time, the fix was to teach the
assembler to recognise one more shape — and each time, the next round found
another.

None of the eleven was a real fragment. Every one was demonstrated by a test
or reproduced during review, and the archive contains no example: all 759
fragments ever written open with an ordinary heading. That is worth stating
plainly rather than letting the list imply a history of damaged releases,
because the argument does not rest on one. What makes these worth closing is
that any of them arrives the first time somebody saves a file a little
differently — and the number of ways a line can fail to be a heading has no
limit, so a rule that has to list them can always be caught out. Being caught
out costs a release note and a file.

The rule now runs the other way round. The opening line has to be a heading
written with `#`, and anything else is refused by name, before a word is
published or a file removed. This does not make the assembler cleverer — it
makes not understanding something safe. The eleven known shapes are covered
because none of them is that one thing, and so is the twelfth nobody has
thought of yet.

It asks nothing new of anyone. Of the 759 fragments ever written in this
repository, all 759 already open with such a heading, so nobody's habits
change; the permissive route had only ever been exercised by the project's
own tests. An author who does trip it gets a message naming the file and the
line, and keeps their work.

One shape that looked like part of this turned out not to be, and is worth
separating. A file saved with the older convention of ending lines with a
carriage return alone was being read as a single enormous line — its heading
was fine, but everything after it was treated as part of the heading, so a
file could be refused because its *body* mentioned a pull request. That is a
different defect in a different place, and it is fixed here too, by reading
line endings the way the renderer does.

Two of the assembler's own descriptions of itself were also corrected: one
said a byte-order mark would be visible to whoever wrote it, when it is
zero-width and the visible consequence is a section losing its heading
entirely; another said the assembler publishes a fragment exactly as written,
when it adjusts links that would otherwise stop working once the text moves
up a directory.
